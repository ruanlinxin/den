import { Module } from '@nestjs/common';
import { DenController } from './den.controller';
import { DenStore } from './store';
import { TokenGuard } from './token.guard';
import { APP_GUARD } from '@nestjs/core';

@Module({
  controllers: [DenController],
  providers: [
    DenStore,
    { provide: APP_GUARD, useClass: TokenGuard },
  ],
})
export class DenModule {}
