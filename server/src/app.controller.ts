import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  /** 根路径,免鉴权,简易探活 */
  @Get()
  root() {
    return { ok: true, service: 'stash' };
  }

  /** 健康检查,免鉴权 */
  @Get('health')
  health() {
    return { ok: true };
  }
}
