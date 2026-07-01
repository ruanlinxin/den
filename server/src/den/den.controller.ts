import { existsSync, createReadStream } from 'node:fs';
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  BadRequestException,
  NotFoundException,
  StreamableFile,
  Header,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UseInterceptors, UploadedFile } from '@nestjs/common';
import type { Response } from 'express';
import { DenStore } from './store';
import type { CreateTextDto, Kind, ListFilter } from './types';

/** 把 multipart 表单字段或 JSON 字段统一解析成 ttl 秒数 */
function parseTtl(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 把标签字段解析成数组:JSON body 的数组 / multipart 的逗号分隔字符串 */
function parseTags(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

function normalizeKind(v: unknown): Kind | undefined {
  return v === 'text' || v === 'file' ? (v as Kind) : undefined;
}

@Controller('den')
export class DenController {
  private readonly logger = new Logger(DenController.name);

  constructor(private readonly store: DenStore) {}

  /** 推送文本 */
  @Post('text')
  async pushText(@Body() body: CreateTextDto) {
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      throw new BadRequestException('`text` is required');
    }
    return this.store.addText(
      body.text,
      body.source,
      parseTtl(body.ttl),
      parseTags(body.tags),
    );
  }

  /** 推送文件(multipart) */
  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB / 文件,与 api.md 一致
      // multer 默认按 latin1 解 multipart filename 字段,中文/emoji 会变 mojibake。
      // 设为 utf8 后,multer 会按 UTF-8 解码,跨设备文件名一致。
      defParamCharset: 'utf8',
    }),
  )
  async pushFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('source') source?: string,
    @Body('ttl') ttl?: string,
    @Body('tags') tags?: string,
  ) {
    if (!file) {
      throw new BadRequestException('`file` field is required');
    }
    return this.store.addFile(
      file.originalname,
      file.buffer,
      source,
      parseTtl(ttl),
      parseTags(tags),
    );
  }

  /** 列表(支持 kind/source/tag 过滤,自动隐藏已过期) */
  @Get()
  list(
    @Query('kind') kind?: string,
    @Query('source') source?: string,
    @Query('tag') tag?: string,
  ) {
    const filter: ListFilter = {};
    const k = normalizeKind(kind);
    if (k) filter.kind = k;
    if (source) filter.source = source;
    if (tag) filter.tag = tag;
    return this.store.list(filter);
  }

  /** 单条元信息 */
  @Get(':id')
  one(@Param('id') id: string) {
    const entry = this.store.get(id);
    if (!entry) throw new NotFoundException();
    return entry;
  }

  /** 下载原始内容(文本 inline,文件 attachment) */
  @Get(':id/content')
  @Header('Cache-Control', 'no-store')
  async content(
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const entry = this.store.get(id);
    if (!entry) throw new NotFoundException();
    if (!existsSync(this.store.filePath(id))) throw new NotFoundException('blob missing');

    const asAttachment = download !== undefined && download !== '0' && download !== 'false';
    const dispositionType = asAttachment || entry.kind === 'file' ? 'attachment' : 'inline';
    // RFC 5987 / RFC 6266 双形式:
    //   filename="<ASCII fallback>" 给老客户端(中文用 '_' 代替)
    //   filename*=UTF-8''<percent-encoded> 给现代客户端(浏览器、curl 都识别)
    // 跨设备下载 Windows 资源管理器 / macOS Safari 都不会再乱码。
    const asciiFallback = entry.name.replace(/[^\x20-\x7E]/g, '_') || 'download';
    const encodedName = encodeURIComponent(entry.name);
    res.set({
      'Content-Type':
        entry.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Disposition':
        `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(entry.size),
    });
    const stream = createReadStream(this.store.filePath(id));
    // 防御性:existsSync 与 createReadStream 之间存在 TOCTOU 窗口;
    // 进程被 kill -9 / 手动删 blob 时,这里捕获 error 避免 unhandled 'error' 事件。
    stream.on('error', (e) => {
      this.logger.error(`stream error on ${id}: ${e.message}`);
    });
    return new StreamableFile(stream);
  }

  /** 删除 */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    const ok = await this.store.remove(id);
    if (!ok) throw new NotFoundException();
    return { ok: true };
  }

  /** 追加标签 */
  @Post(':id/tags')
  addTags(@Param('id') id: string, @Body('tags') tags?: unknown) {
    if (!this.store.get(id)) throw new NotFoundException();
    this.store.addTags(id, parseTags(tags) ?? []);
    return this.store.get(id);
  }

  /** 删除单个标签 */
  @Delete(':id/tags/:tag')
  removeTag(@Param('id') id: string, @Param('tag') tag: string) {
    if (!this.store.get(id)) throw new NotFoundException();
    this.store.removeTag(id, decodeURIComponent(tag));
    return this.store.get(id);
  }
}
