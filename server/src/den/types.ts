export type Kind = 'text' | 'file';

export interface Entry {
  id: string;
  kind: Kind;
  name: string; // text: 'text.txt';file: 原始文件名
  size: number; // 字节
  createdAt: number; // ms 时间戳
  source?: string | null; // 来源主机名(可选)
  tags: string[]; // 标签(聚合自 entry_tags)
  expiresAt?: number | null; // ms,过期时间;null/缺省 = 永不过期
}

export interface CreateTextDto {
  text: string;
  source?: string;
  ttl?: number; // 有效期(秒),>0 生效
  tags?: string[];
}

export interface ListFilter {
  kind?: Kind;
  source?: string;
  tag?: string;
}
