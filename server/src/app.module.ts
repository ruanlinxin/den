import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StashModule } from './stash/stash.module';

@Module({
  imports: [StashModule],
  controllers: [AppController],
})
export class AppModule {}
