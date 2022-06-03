import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../database/db.service';
import { Web3Service } from '../utils/web3.service';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { getTokenEventModel } from '../common/models/TokenEventModel';
import { Constants } from '../../constants';
import { SubTasksService } from './sub-tasks.service';
import { ContractTokenInfo, OrderEventType, OrderState } from './interfaces';
import { ConfigService } from '@nestjs/config';
import { getOrderEventModel } from '../common/models/OrderEventModel';
import { CallOfBatch } from '../utils/interfaces';
import { getBidOrderEventModel } from '../common/models/BidOrderEventModel';
import { Timeout } from '@nestjs/schedule';
import { Sleep } from '../utils/utils.service';

@Injectable()
export class TasksService {
  private readonly logger = new Logger('TasksService');
  private readonly step = 10000;

  constructor(
    private subTasksService: SubTasksService,
    private configService: ConfigService,
    private dbService: DbService,
    private web3Service: Web3Service,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private getBaseBatchRequestParam(event: any): CallOfBatch[] {
    return [
      {
        method: this.web3Service.web3RPC.eth.getTransaction,
        params: event.transactionHash,
      },
      {
        method: this.web3Service.web3RPC.eth.getBlock,
        params: event.blockNumber,
      },
    ];
  }

  @Timeout('transfer', 1000)
  async handleTransferEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getTokenEventLastHeight();

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;
      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past Transfer events from [${fromBlock}] to [${toBlock}]`);

        this.web3Service.metContractWS
          .getPastEvents('Transfer', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleTransferEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past Transfer events from [${lastHeight + 1}] to [${nowHeight}] finished ✅☕🚾️`,
      );
    }

    this.logger.log(`Start sync Transfer events from [${syncStartBlock + 1}] 💪💪💪 `);

    this.web3Service.metContractWS.events
      .Transfer({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        await this.handleTransferEventData(event);
      });
  }

  private async handleTransferEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      from: event.returnValues._from,
      to: event.returnValues._to,
      tokenId: event.returnValues._tokenId,
    };

    this.logger.log(`Received Transfer Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo, contractTokenInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
      {
        method: this.web3Service.metContractRPC.methods.tokenInfo(event.returnValues._tokenId).call,
        params: {},
      },
    ]);

    const TokenEventModel = getTokenEventModel(this.connection);
    const tokenEvent = new TokenEventModel({
      ...eventInfo,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await tokenEvent.save();

    if (eventInfo.from === Constants.BURN_ADDRESS) {
      this.subTasksService.dealWithNewToken(contractTokenInfo as ContractTokenInfo);
    } else {
      if (eventInfo.to !== this.configService.get('CONTRACT_MARKET')) {
        this.dbService.updateTokenOwner(eventInfo.tokenId, eventInfo.to);
      }
    }
  }

  @Timeout('orderForAuction', 2000)
  async handleOrderForAuctionEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(OrderEventType.OrderForAuction);

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;
      while (fromBlock <= nowHeight) {
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        this.logger.log(`Sync past OrderForAuction events from [${fromBlock}] to [${toBlock}]`);
        this.web3Service.metMarketContractWS
          .getPastEvents('OrderForAuction', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderForAuctionEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderForAuction events from [${
          lastHeight + 1
        }] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderForAuction events from [${syncStartBlock + 1}] 💪💪💪 `);

    this.web3Service.metMarketContractWS.events
      .OrderForAuction({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderForAuctionEventData(event);
      });
  }

  private async handleOrderForAuctionEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      orderId: event.returnValues._orderId,
      tokenId: event.returnValues._tokenId,
      quoteToken: event.returnValues._quoteToken,
      minPrice: event.returnValues._minPrice,
      endTime: event.returnValues._endTime,
    };

    this.logger.log(`Received OrderForAuction Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo, contractOrderInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
      {
        method: this.web3Service.metMarketContractRPC.methods.getOrderById(
          event.returnValues._orderId,
        ).call,
        params: {},
      },
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderForAuction,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.subTasksService.dealWithNewOrder(contractOrderInfo);
  }

  @Timeout('orderBid', 5000)
  async handleOrderBidEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getBidOrderEventLastHeight();

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;
      while (fromBlock <= nowHeight) {
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        this.logger.log(`Sync past OrderBid events from [${fromBlock}] to [${toBlock}]`);
        this.web3Service.metMarketContractWS
          .getPastEvents('OrderBid', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderBidEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderBid events from [${lastHeight + 1}] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderBid events from [${syncStartBlock + 1}] 💪💪💪 `);
    this.web3Service.metMarketContractWS.events
      .OrderBid({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderBidEventData(event);
      });
  }

  private async handleOrderBidEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      buyer: event.returnValues._buyer,
      orderId: event.returnValues._orderId,
      price: event.returnValues._price,
    };

    this.logger.log(`Received BidOrder Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo, contractOrderInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
      {
        method: this.web3Service.metMarketContractRPC.methods.getOrderById(
          event.returnValues._orderId,
        ).call,
        params: {},
      },
    ]);

    const BidOrderEventModel = getBidOrderEventModel(this.connection);
    const bidOrderEvent = new BidOrderEventModel({
      ...eventInfo,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await bidOrderEvent.save();

    this.subTasksService.updateOrder(eventInfo.orderId, {
      orderState: contractOrderInfo.orderState,
      buyerAddr: contractOrderInfo.buyerAddr,
      buyerUri: contractOrderInfo.buyerUri,
      filled: contractOrderInfo.filled,
      platformAddr: contractOrderInfo.platformAddr,
      platformFee: contractOrderInfo.platformFee,
      updateTime: contractOrderInfo.timestamp,
      bids: contractOrderInfo.bids,
      lastBid: contractOrderInfo.lastBid,
      lastBidder: contractOrderInfo.lastBidder,
    });
  }

  @Timeout('orderForSale', 2000)
  async handleOrderForSaleEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(OrderEventType.OrderForSale);

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;

      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past OrderForSale events from [${fromBlock}] to [${toBlock}]`);
        this.web3Service.metMarketContractWS
          .getPastEvents('OrderForSale', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderForSaleEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderForSale events from [${
          lastHeight + 1
        }] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderForSale events from [${syncStartBlock + 1}] 💪💪💪 `);
    this.web3Service.metMarketContractWS.events
      .OrderForSale({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderForSaleEventData(event);
      });
  }

  private async handleOrderForSaleEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      orderId: event.returnValues._orderId,
      tokenId: event.returnValues._tokenId,
      price: event.returnValues._price,
    };

    this.logger.log(`Received OrderForSale Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo, contractOrderInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
      {
        method: this.web3Service.metMarketContractRPC.methods.getOrderById(
          event.returnValues._orderId,
        ).call,
        params: {},
      },
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderForSale,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.subTasksService.dealWithNewOrder(contractOrderInfo);
  }

  @Timeout('orderPriceChanged', 5000)
  async handleOrderPriceChangedEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(
      OrderEventType.OrderPriceChanged,
    );

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;

      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past OrderPriceChanged events from [${fromBlock}] to [${toBlock}]`);

        this.web3Service.metMarketContractWS
          .getPastEvents('OrderPriceChanged', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderPriceChangedEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderPriceChanged events from [${
          lastHeight + 1
        }] to [${nowHeight}] finished ✅☕🚾️`,
      );
    }

    this.logger.log(`Start sync OrderPriceChanged events from [${syncStartBlock + 1}] 💪💪💪 `);

    this.web3Service.metMarketContractWS.events
      .OrderPriceChanged({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderPriceChangedEventData(event);
      });
  }

  private async handleOrderPriceChangedEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      orderId: event.returnValues._orderId,
      oldPrice: event.returnValues._oldPrice,
      newPrice: event.returnValues._newPrice,
    };

    this.logger.log(`Received OrderPriceChanged Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderPriceChanged,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.dbService.updateOrder(eventInfo.orderId, {
      price: eventInfo.newPrice,
      updateTime: orderEvent.timestamp,
    });
  }

  @Timeout('orderFilled', 5000)
  async handleOrderFilledEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(OrderEventType.OrderFilled);

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;

      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past OrderFilled events from [${fromBlock}] to [${toBlock}]`);

        this.web3Service.metMarketContractWS
          .getPastEvents('OrderFilled', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderFilledEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderFilled events from [${lastHeight + 1}] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderFilled events from [${syncStartBlock + 1}] 💪💪💪 `);
    this.web3Service.metMarketContractWS.events
      .OrderFilled({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderFilledEventData(event);
      });
  }

  private async handleOrderFilledEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      buyer: event.returnValues._buyer,
      orderId: event.returnValues._orderId,
      quoteToken: event.returnValues._quoteToken,
      price: event.returnValues._price,
      royaltyOwner: event.returnValues._royaltyOwner,
      royaltyFee: event.returnValues._royaltyFee,
      platformAddress: event.returnValues._platformAddr,
      platformFee: event.returnValues._platformFee,
    };

    this.logger.log(`Received OrderFilled Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo, contractOrderInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
      {
        method: this.web3Service.metMarketContractRPC.methods.getOrderById(
          event.returnValues._orderId,
        ).call,
        params: {},
      },
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderFilled,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.subTasksService.updateOrder(eventInfo.orderId, {
      orderState: contractOrderInfo.orderState,
      buyerAddr: contractOrderInfo.buyerAddr,
      buyerUri: contractOrderInfo.buyerUri,
      filled: contractOrderInfo.filled,
      platformAddr: contractOrderInfo.platformAddr,
      platformFee: contractOrderInfo.platformFee,
      updateTime: contractOrderInfo.timestamp,
    });
  }

  @Timeout('orderCancelled', 5000)
  async handleOrderCancelledEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(OrderEventType.OrderCancelled);

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;

      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past OrderCancelled events from [${fromBlock}] to [${toBlock}]`);

        this.web3Service.metMarketContractWS
          .getPastEvents('OrderCanceled', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderCancelledEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderCancelled events from [${
          lastHeight + 1
        }] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderCancelled events from [${syncStartBlock + 1}] 💪💪💪 `);
    this.web3Service.metMarketContractWS.events
      .OrderCanceled({
        fromBlock: syncStartBlock + 1,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderCancelledEventData(event);
      });
  }

  private async handleOrderCancelledEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      orderId: event.returnValues._orderId,
    };

    this.logger.log(`Received OrderCancelled Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderCancelled,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.dbService.updateOrder(eventInfo.orderId, {
      orderState: OrderState.Cancelled,
      updateTime: orderEvent.timestamp,
    });
  }

  @Timeout('orderTakenDown', 5000)
  async handleOrderTakenDownEvent() {
    const nowHeight = await this.web3Service.web3RPC.eth.getBlockNumber();
    const lastHeight = await this.dbService.getOrderEventLastHeight(OrderEventType.OrderTakenDown);

    let syncStartBlock = lastHeight;

    if (nowHeight - lastHeight > this.step + 1) {
      syncStartBlock = nowHeight;

      let fromBlock = lastHeight + 1;
      let toBlock = fromBlock + this.step;

      while (fromBlock <= nowHeight) {
        this.logger.log(`Sync past OrderTakenDown events from [${fromBlock}] to [${toBlock}]`);

        this.web3Service.metMarketContractWS
          .getPastEvents('OrderTakenDown', {
            fromBlock,
            toBlock,
          })
          .then((events) => {
            events.forEach(async (event) => {
              await this.handleOrderTakenDownEventData(event);
            });
          });
        fromBlock = toBlock + 1;
        toBlock = fromBlock + this.step > nowHeight ? nowHeight : toBlock + this.step;
        await Sleep(1000 * 10);
      }

      this.logger.log(
        `Sync past OrderTakenDown events from [${
          lastHeight + 1
        }] to [${nowHeight}] finished ✅☕🚾️️`,
      );
    }

    this.logger.log(`Start sync OrderTakenDown events from [${syncStartBlock + 1}] 💪💪💪 `);
    this.web3Service.metMarketContractWS.events
      .OrderTakenDown({
        fromBlock: syncStartBlock,
      })
      .on('error', (error) => {
        this.logger.error(error);
      })
      .on('data', async (event) => {
        this.handleOrderTakenDownEventData(event);
      });
  }

  private async handleOrderTakenDownEventData(event: any) {
    const eventInfo = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      seller: event.returnValues._seller,
      orderId: event.returnValues._orderId,
    };

    this.logger.log(`Received OrderTakenDown Event: ${JSON.stringify(eventInfo)}`);

    const [txInfo, blockInfo] = await this.web3Service.web3BatchRequest([
      ...this.getBaseBatchRequestParam(event),
    ]);

    const OrderEventModel = getOrderEventModel(this.connection);
    const orderEvent = new OrderEventModel({
      ...eventInfo,
      eventType: OrderEventType.OrderTakenDown,
      gasFee: (txInfo.gas * txInfo.gasPrice) / 10 ** 18,
      timestamp: blockInfo.timestamp,
    });

    await orderEvent.save();

    this.dbService.updateOrder(eventInfo.orderId, {
      orderState: OrderState.TakenDown,
      updateTime: orderEvent.timestamp,
    });
  }
}