import { Module } from '@nestjs/common';
import { StashController } from './stash.controller';
import { StashStore } from './store';
import { TokenGuard } from './token.guard';
import { APP_GUARD } from '@nestjs/core';

@Module({
  controllers: [StashController],
  providers: [
    StashStore,
    { provide: APP_GUARD, useClass: TokenGuard },
  ],
})
export class StashModule {}
