import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { CommonResponse } from '../utils/interfaces';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('/check')
  async check(): Promise<CommonResponse> {
    return await this.appService.check();
  }

  @Get('/getCollectibleByTokenId')
  async getCollectibleByTokenId(@Query('tokenId') tokenId: string): Promise<CommonResponse> {
    return await this.appService.getCollectibleByTokenId(tokenId);
  }

  @Get('/getTransHistoryByTokenId')
  async getTransHistoryByTokenId(@Query('tokenId') tokenId: string): Promise<CommonResponse> {
    return await this.appService.getTransHistoryByTokenId(tokenId);
  }

  @Get('/getEarnedByAddress')
  async getEarnedByAddress(@Query('address') address: string): Promise<CommonResponse> {
    return await this.appService.getEarnedByAddress(address, false, false);
  }

  @Get('/getTodayEarnedByAddress')
  async getTodayEarnedByAddress(@Query('address') address: string): Promise<CommonResponse> {
    return await this.appService.getEarnedByAddress(address, true, false);
  }

  @Get('/getEarnedListByAddress')
  async getEarnedListByAddress(@Query('address') address: string): Promise<CommonResponse> {
    return await this.appService.getEarnedByAddress(address, false, true);
  }
}
