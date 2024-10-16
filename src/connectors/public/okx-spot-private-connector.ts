import axios from 'axios';
import { WebSocket } from 'ws';
import CryptoJS from 'crypto-js';
import {
  BalanceRequest,
  BalanceResponse,
  BatchOrdersRequest,
  CancelOrdersRequest,
  ConnectorConfiguration,
  ConnectorGroup,
  Credential,
  OpenOrdersRequest,
  OrderState,
  OrderStatusUpdate,
  PrivateExchangeConnector,
  Serializable,
  Side,
  SklEvent,
} from '../../types';
import { getOkxSymbol } from "./okx-spot";
import { Logger } from '../../util/logging';
import { getSklSymbol } from '../../util/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
const logger = Logger.getInstance('okx-spot-private-connector')

interface OkxEvent {
    event: string,
    channel: string,
    timestamp: string,
    sequence_num: number,
    data: OkxOpenOrderResponse[] | OkxOrderStatusEvent[],
}


export interface OkxPlaceOrderRequest {
    id: string;
    op: string;
    args: Array<{
      side: string;
      instId: string;
      tdMode: string;
      ordType: string;
      sz: number;
    }>;
}
  
export interface OkxPlaceOrderResponse {
    id: string;
    op: string;
    data: Array<{
      clOrdId: string;
      ordId: string;
      tag: string;
      sCode: string;
      sMsg: string;
    }>;
    code: string;
    msg: string;
    inTime: string;
    outTime: string;
}
  


interface OkxOpenOrderResponse {
  type: string;
  orders: OkxOpenOrder[];
}

interface OkxOrderStatusEvent {
  orders: OkxOrderStatus[];
  sequence: string;
  has_next: boolean;
  cursor: string;
}

interface OkxOrderStatus {
  order_id: string,
  client_order_id: string,
  cumulative_quantity: string,
  leaves_quantity: string,
  avg_price: string,
  total_fees: string,
  status: string,
  product_id: string,
  creation_time: string,
  order_side: string,
  order_type: string,
  cancel_reason: string,
  reject_Reason: string,
}

interface OkxOpenOrder {
  order_id: string;
  product_id: string;
  user_id: string;
  side: string;
  client_order_id: string;
  status: string;
  time_in_force: string;
  created_time: string;
  filled_size: string;
  average_filled_price: string;
  fee: string;
  number_of_fills: string;
  filled_value: string;
  total_fees: string;
  order_configuration: {
    limit_limit_gtc: {
      post_only: boolean;
      end_time: string;
      base_size: string;
      limit_price: string;
    }
  }
}

const OkxWebsocketOrderUpdateStateMap: { [key: string]: OrderState } = {
    'live': 'Placed',
    'filled': 'Filled',
    'partially_filled': 'PartiallyFilled',
    'canceled': 'Cancelled',
};

const OkxOpenOrdersStateMap: { [key: string]: OrderState } = {
    'live': 'Placed',
    'partially_filled': 'PartiallyFilled',
};

const OkxOrderTypeMap: { [key: string]: OkxOrderType } = {
    'Limit': 'limit',
    'Market': 'market',
    'LimitMaker': 'post_only',
    'ImmediateOrCancel': 'ioc'
};

type OkxSide = 'BUY' | 'SELL'
const invertedSideMap: { [key: string]: OkxSide } = {
    'Buy': 'BUY',
    'Sell': 'SELL'
}

const getEventType = (message: OkxEvent): SklEvent | null => {
    if (message.channel === 'user') {
        return 'OrderStatusUpdate'
    }
    return null
}

export class OkxSpotPrivateConnector implements PrivateExchangeConnector {
    public privateWebsocketAddress = 'wss://wseea.okx.com:8443/ws/v5/private';
    public restUrl = 'http://www.okx.com';
    public privateWebsocketFeed: any
    private okxSymbol: string
    private sklSymbol: string
    private pingInterval: any


    constructor(
        private group: ConnectorGroup,
        private config: ConnectorConfiguration,
        private credential: Credential,
    ) {
        const self = this
        self.okxSymbol = getOkxSymbol(self.group, self.config)
        self.sklSymbol = getSklSymbol(self.group, self.config)
    }

    public async connect(onMessage: (m: Serializable[]) => void): Promise<any> {
        const self = this
        //const listenKey = await this.getListenKey();

        const privateFeed = new Promise(async (resolve) => {
        
        const url = self.privateWebsocketAddress;
        self.privateWebsocketFeed = new WebSocket(url);
        
        self.privateWebsocketFeed.on('open', () => {
            self.startPingInterval();
            self.authenticate()
            self.subscribeToPrivateChannels();
        });

        self.privateWebsocketFeed.onmessage = (message: any) => {

            const OkxEvent: OkxEvent = JSON.parse(message.data) as OkxEvent
            logger.log(`Private websocket message: ${message.data}`)
            const actionType: SklEvent | null = getEventType(OkxEvent)
            if (actionType) {
                const serializableMessages: Serializable[] = self.createSklEvent(actionType, OkxEvent, self.group)
                onMessage(serializableMessages);
            } else {
                logger.log(`No handler for message: ${JSON.stringify(OkxEvent)}`)
            }
        }

        self.privateWebsocketFeed.on('error', function error(err: any) {
            logger.log(`WebSocket error: ${err.toString()}`);
        });

        self.privateWebsocketFeed.on('close', (code, reason) => {
            const self = this
            logger.log(`WebSocket closed: ${code} - ${reason}`);
            self.stopPingInterval();
            setTimeout(() => {
                this.connect(onMessage);
            }, 1000);
        });
        })

        return await Promise.all([privateFeed]);
    }

    private async authenticate(): Promise<void> {
        const self = this
        const timestamp = Date.now();
        const method = 'GET';
        const requestPath = '/users/self/verify';
        const sign = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(`${timestamp}${method}${requestPath}`, self.credential.secret));
        
        const authMessage = JSON.stringify({
            op: 'login',
            args: [{
                apiKey: this.credential.key,
                passphrase: this.credential.passphrase,
                timestamp,
                sign
            }]
        });
        this.privateWebsocketFeed.send(JSON.stringify(authMessage));
    }

    private subscribeToPrivateChannels(): void {
        const channels = [
            { channel: 'orders', instId: 'ANY' },
            { channel: 'account', instId: 'ANY' },
            ];
        const subscriptionMessage = {
            op: 'subscribe',
            args: channels
            };
            this.privateWebsocketFeed.send(JSON.stringify(subscriptionMessage));
    }

    private unsubscribeFromPrivateChannels() {
        const channels = [
            { channel: 'orders', instId: 'ANY' },
            { channel: 'account', instId: 'ANY' },
        ];
        const subscriptionMessage = {
            op: 'unsubscribe',
            args: channels
        };
        this.privateWebsocketFeed.send(JSON.stringify(subscriptionMessage));
    }

    public async stop(): Promise<void> {
        const self = this
        try {
            self.unsubscribeFromPrivateChannels();
            clearInterval(self.pingInterval);
            await self.deleteAllOrders({
                symbol: self.sklSymbol,
                event: 'CancelOrdersRequest',
                timestamp: Date.now(),
                connectorType: 'Okx'
            });
            self.stopPingInterval();
            self.privateWebsocketFeed.close();
        } catch (error){
            logger.error('Error during stop operation:', error);
        }
    }
  
    public async placeOrders(request: BatchOrdersRequest): Promise<any> {
        const OkxMaxBatchSize = 20; // Example limit
        //example order for dev
        const side = invertedSideMap[order.side];
        const instId = "BTC-USDT";
        const tdMode = "cash";
        const ordType = "market";
        const orderId = `skl:${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
        //Map Orders
        const orders = request.orders.map(order => {
            return {
                id: orderId,
                op: "order",
                args: [{
                    side: side,
                    instId: instId,
                    tdMode: tdMode,
                    ordType: ordType,
                    sz: order.quantity.toFixed(8),
                }]
            };
        });
    
        const batches = this.chunkArray(orders, OkxMaxBatchSize);
    
        const promises = batches.map(batch => {
            //set dynamic endpoint
            const endpoint = '/account/balance?ccy=BTC'
            return this.postRequest(endpoint, { batchOrders: JSON.stringify(batch) });
        });
    
        const results = await Promise.all(promises);
        return results;
    }
    
    private chunkArray(array: any[], chunkSize: number): any[] {
        const results = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            results.push(array.slice(i, i + chunkSize));
        }
        return results;
    }
    
    private async postRequest(endpoint: string, params: any): Promise<any> {
        const self = this
        const timestamp = Date.now() / 1000;
        const method = 'POST';
        const requestPath = `/api/v5${endpoint}`;
        
        const body = JSON.stringify(params);

        const sign = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(`${timestamp}${method}${requestPath}${body}`, this.credential.secret));

        const headers = {
            'OK-ACCESS-KEY': self.credential.key,
            'OK-ACCESS-SIGN': sign,
            'OK-ACCESS-TIMESTAMP': timestamp.toString(),
            'OK-ACCESS-PASSPHRASE': self.credential.passphrase,
            'Content-Type': 'application/json'
        };

        try {
            const result = await self.axios.post(`${self.restUrl}${requestPath}`, body, { headers });
            return result.data;
        } catch (error) {
            logger.log(`POST Error: ${error.toString()}`);
        }
    }

    private async deleteRequest(endpoint: string): Promise<any> {
        const self = this;
        const timestamp = Date.now() / 1000;
        const method = 'DELETE';
        const requestPath = `/api/v5/delete${endpoint}`;

        const sign = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(`${timestamp}${method}${requestPath}`, this.credential.secret));

        const headers = {
            'OK-ACCESS-KEY': self.credential.key,
            'OK-ACCESS-SIGN': sign,
            'OK-ACCESS-TIMESTAMP': timestamp.toString(),
            'OK-ACCESS-PASSPHRASE': self.credential.passphrase,
            'Content-Type': 'application/json'
        };

        try {
            const result = await self.axios.delete(`${self.restUrl}${requestPath}`, { headers });
            return result.data;
        } catch (error) {
            logger.log(`DELETE Error: ${error.toString()}`);
        }
    }

    private async getRequest(route: string, params: any): Promise<any> {
        const self = this
        let queryString = '';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const requestPath = `/api/v5${route}`;
        const sign = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(`${timestamp}${method}${requestPath}${queryString}`, this.credential.secret));

        if (Object.keys(params).length > 0) {
            queryString = '?' + new URLSearchParams(params).toString();
        }

        const headers = {
            'OK-ACCESS-KEY': self.credential.key,
            'OK-ACCESS-SIGN': sign,
            'OK-ACCESS-TIMESTAMP': timestamp.toString(),
            'OK-ACCESS-PASSPHRASE': self.credential.passphrase,
        };

        try {
            const result = await self.axios.get(`${self.restUrl}${requestPath}${queryString}`, { headers });
            return result.data;
        } catch (error) {
            console.log(error);
        }
    }

    public async deleteAllOrders(request: CancelOrdersRequest): Promise<void> {
        const { orderIds } = request;
        const okxMaxBatchSize = 20;
        logger.log('DeleteAllOrders Process Initiated');
        const batches = this.chunkArray(orderIds, okxMaxBatchSize);

        try {
            const results = await Promise.all(batches.map(async (batch) => {
                const cancelBatchRequest = {
                    instId: this.okxSymbol,
                    orders: batch.map(id => ({ ordId: id }))
                };
                
                return this.postRequest('/api/v5/trade/cancel-batch-orders', cancelBatchRequest);
            }));

            logger.log('Order cancellation results:', results);
        } catch (error) {
            logger.error('Error cancelling orders:', error);
        }
    }


    public async getBalancePercentage(request: BalanceRequest): Promise<BalanceResponse> {
        const self = this
        const result = await this.getRequest('/api/v5/account/balance', {});

        const baseAsset = this.group.name;
        const quoteAsset = this.config.quoteAsset;

        const balances = result.data[0].details;
        const base = balances.find((b: any) => b.ccy === baseAsset) || { cashBal: '0', frozenBal: '0' };
        const quote = balances.find((b: any) => b.ccy === quoteAsset) || { cashBal: '0', frozenBal: '0' };

        const baseVal = parseFloat(base.cashBal) + parseFloat(base.frozenBal);
        const baseValue = baseVal * request.lastPrice;
        const quoteValue = parseFloat(quote.cashBal) + parseFloat(quote.frozenBal);

        const whole = baseValue + quoteValue;
        const pairPercentage = (baseValue / whole) * 100;

        return {
            event: "BalanceRequest",
            symbol: self.sklSymbol,
            baseBalance: baseVal,
            quoteBalance: quoteValue,
            inventory: pairPercentage,
            timestamp: new Date().getTime()
        };
    }
    
    public async getCurrentActiveOrders(request: OpenOrdersRequest): Promise<OrderStatusUpdate[]> {
        const endpoint = '/api/v3/openOrders'; // update endpoint 
        const response = await this.getRequest(endpoint, { symbol: this.exchangeSymbol });
    
        return response.map(order => ({
            event: 'OrderStatusUpdate',
            connectorType: 'ExchangeName',
            symbol: this.sklSymbol,
            orderId: order.orderId,
            sklOrderId: order.clientOrderId,
            state: mapOrderState(order.status),
            side: mapExchangeSide(order.side),
            price: parseFloat(order.price),
            size: parseFloat(order.origQty),
            notional: parseFloat(order.price) * parseFloat(order.origQty),
            filled_price: parseFloat(order.price),
            filled_size: parseFloat(order.executedQty),
            timestamp: order.time,
        }));
    }

    private getEventType(message: OkxEvent): SklEvent | null {
        if (message.event != 'error'){
            if (message.channel === 'orders') {
                return 'OrderStatusUpdate';
            }
        } else if (message.event === 'error') {
            logger.error(`Error message received: ${message.msg}`);
            return null;
        }
    }

    private createSklEvent(event: SklEvent, message: any, group: ConnectorGroup): Serializable[] {
        if (event === 'OrderStatusUpdate') {
            return message.data.map((order: any) => this.createOrderStatusUpdate(event, order, group));
        } else {
            return [];
        }
    }

    private createOrderStatusUpdate(action: SklEvent, order: any, group: ConnectorGroup): OrderStatusUpdate {
        const state: OrderState = OkxWSOrderUpdateStateMap[order.state];
        const side: Side = OkxSideMap[order.side];

        return {
            symbol: this.sklSymbol,
            connectorType: 'Okx',
            event: action,
            state,
            orderId: order.ordId,
            sklOrderId: order.clOrdId,
            side,
            price: parseFloat(order.px),
            size: parseFloat(order.sz),
            notional: parseFloat(order.px) * parseFloat(order.sz),
            filled_price: parseFloat(order.avgPx),
            filled_size: parseFloat(order.accFillSz),
            timestamp: parseInt(order.uTime)
        };
    }

    private startPingInterval(): void {
        this.pingInterval = setInterval(() => {
            this.privateWebsocketFeed.send(JSON.stringify({ method: 'PING' }));
        }, 5000); 
    }

    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
  

}
