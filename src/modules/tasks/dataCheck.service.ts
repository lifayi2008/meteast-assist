import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../database/db.service';
import { Web3Service } from '../utils/web3.service';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
export class DataCheckService {
  private readonly logger = new Logger('DataCheckService');

  constructor(
    private configService: ConfigService,
    private dbService: DbService,
    private web3Service: Web3Service,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @Interval(1000 * 60 * 2)
  async OrderAndTokenCountCheck() {
    const dbOrderCount = await this.dbService.orderCount();
    const dbTokenCount = await this.dbService.tokenCount();

    const [web3OrderCount, web3TokenCount] = await this.web3Service.web3BatchRequest([
      {
        method: this.web3Service.metContractRPC.methods.getOrderCount().call,
        params: {},
      },
      {
        method: this.web3Service.metContractRPC.methods.totalSupply().call,
        params: {},
      },
    ]);

    this.logger.log(`DB Order Count: ${dbOrderCount}     Web3 Order Count: ${web3OrderCount}`);
    this.logger.log(`DB Token Count: ${dbTokenCount}     Web3 Token Count: ${web3TokenCount}`);
  }
}
