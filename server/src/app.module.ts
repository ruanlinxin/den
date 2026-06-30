import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DenModule } from './den/den.module';

@Module({
  imports: [DenModule],
  controllers: [AppController],
})
export class AppModule {}
