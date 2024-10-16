import { ConnectorConfiguration, ConnectorGroup, PublicExchangeConnector, Serializable, SklEvent, Ticker, TopOfBook, Trade } from "../../types";
import { getSklSymbol } from "../../util/config";
import { Logger } from "../../util/logging";
import { WebSocket } from 'ws'
import { getOkxSymbol, okxSideMap } from "./okx-spot";

//Interfaces //

type OkxEventType = 'snapshot' | 'update'

interface OkxEvent {
    event: string; // "subscribe" or "error"
    channel: string; 
    arg?: Record<string, unknown>; // {Channel, InstId}
    connId?: string; 
    code?: string; 
    msg?: string; 
    timestamp: string; 
    sequence_num: number;
    data: OkxMarketDepthEvent[] | OkxTradeEvent[] | OkxTickerEvent[];
}


type OkxMarketDepthSide = 'bid' | 'offer'
interface OkxMarketDepthLevel {
    side: OkxMarketDepthSide,
    event_time: string,
    price_level: string,
    new_quantity: string,
}

interface OkxMarketDepthEvent {
    type: OkxEventType,
    product_id: string,
    updates: OkxMarketDepthLevel[],
}

interface OkxTicker {
    symbol: string;
    connectorType: 'Okx';
    event: 'Ticker';
    instId: string;
    lastPrice: string;
    timestamp: string;
}

interface OkxTickerEvent {
    type: OkxEventType,
    tickers: OkxTicker[],
}

interface OkxTrade {
    symbol: string;
    instId: string;
    tradeId: string;
    price: string;
    size: string;
    side: string;
    timestamp: string;
}

interface OkxTradeEvent {
    type: OkxEventType,
    trades: OkxTrade[],
}

const logger = Logger.getInstance('okx-spot-public-connector');


export class OKXSpotPublicConnector implements PublicExchangeConnector {
    
    public publicWebsocketAddress = 'wss://wseea.okx.com:8443/ws/v5/public';
    public restUrl = 'http://www.okx.com';
    public publicWebsocketFeed: any;
    private okxSymbol: string;
    private sklSymbol: string;
    public bids: OkxMarketDepthLevel[] = [];
    public asks: OkxMarketDepthLevel[] = [];

    constructor(
        private group: ConnectorGroup,
        private config: ConnectorConfiguration
    ) {
        const self = this
        self.okxSymbol = getOkxSymbol(self.group, self.config)
        self.sklSymbol = getSklSymbol(self.group, self.config)
    }

    public async connect(onMessage: (message: Serializable[]) => void): Promise<any> {
            
        const self = this
        const publicFeed = new Promise((resolve) => {
            const url = self.publicWebsocketAddress;
            self.publicWebsocketFeed = new WebSocket(url);
            
            self.publicWebsocketFeed.on('open', () => {
                logger.log('WebSocket opened');
                self.subscribeToChannels();
            });

            self.publicWebsocketFeed.onmessage = (message: any) => {
                try {
                    const OkxEvent: OkxEvent = JSON.parse(message.data) as OkxEvent;
                    
                    const actionType: SklEvent | null = self.getEventType(OkxEvent);
                    if (actionType) {
                        const serializableMessages: Serializable[] = self.createSklEvent(actionType, OkxEvent, self.group)
                            .filter((serializableMessage: Serializable | null) => serializableMessage !== null) as Serializable[];
                        
                        if (serializableMessages.length > 0) {
                            onMessage(serializableMessages);
                        } 
                        else {
                            logger.log(`No messages generated for event: ${JSON.stringify(OkxEvent)}`);
                        }
                    } 
                    else {
                        logger.log(`No handler for message: ${JSON.stringify(OkxEvent)}`);
                    }
                } 
                catch (error) {
                    logger.error('Error parsing WebSocket message:', error);
                }
            };

            self.publicWebsocketFeed.on('error', function error(err: any) {
                logger.log(`WebSocket error: ${err.toString()}`);
            });

            self.publicWebsocketFeed.on('close', (code: string, msg: string) => {
                const self = this
                logger.log(`WebSocket closed: ${code} - ${msg}`);
                setTimeout(() => {
                    self.connect(onMessage);
                }, 1000);
            });
        });
        return await Promise.all([publicFeed]);
    };


    private subscribeToChannels() {
        const channels = [
            { channel: 'tickers', instId: 'BTC-USD' },
            { channel: 'trades', instId: 'BTC-USD' },
            { channel: 'books', instId: 'BTC-USD' }
        ];
        const subscriptionMessage = {
            op: 'subscribe',
            args: channels
        };
        this.publicWebsocketFeed.send(JSON.stringify(subscriptionMessage));
    }

    private unsubscribeFromChannels() {
        const channels = [
            { channel: 'tickers', instId: 'BTC-USD' },
            { channel: 'trades', instId: 'BTC-USD' },
            { channel: 'books', instId: 'BTC-USD' }
        ];
        const unsubscribeMessage = {
            op: 'unsubscribe',
            args: channels
        };
        this.publicWebsocketFeed.send(JSON.stringify(unsubscribeMessage));
    }

    public async stop(): Promise<void> {
        try {
          await this.unsubscribeFromChannels();
          await this.publicWebsocketFeed.close();
        } catch (error) {
          logger.error('Error during stop operation:', error);
        }
    }
      
    private getEventType(message: OkxEvent): SklEvent | null {
        if (message.event != 'error'){
            if (message.channel === 'trades') {
                return 'Trade';
            } else if (message.channel === 'books') {
                return 'TopOfBook';
            } else if (message.channel === 'tickers') {
                return 'Ticker';
            }
        } else if (message.event === 'error') {
            logger.error(`Error message received: ${message.msg}`);
            return null;
        }
    }
    
    private createSklEvent(event: SklEvent, message: OkxEvent, group: ConnectorGroup): Serializable[]{
        const self = this
        if (event === 'TopOfBook') {
            const marketDepth: OkxMarketDepthEvent[] = message.data as OkxMarketDepthEvent[]
            marketDepth.map((event: OkxMarketDepthEvent) => {
                self.updateBook(event)
            })
            return [self.createTopOfBook(message.timestamp)]
        }
        else if (event === 'Trade') {
            const trades: OkxTradeEvent[] = message.data as OkxTradeEvent[]
            return trades
                .flatMap((event: OkxTradeEvent) => {
                    const mixedTrades: (Trade | null)[] = event.trades
                        .map((trade: OkxTrade) => {
                            return self.createTrade(trade)
                        })
                    const sklTrades: Trade[] = mixedTrades.filter((trade: Trade | null) => trade !== null) as Trade[]
                    return sklTrades
                })

        } else if (event === 'Ticker') {
            const tickers: OkxTickerEvent[] = message.data as OkxTickerEvent[]
            return tickers
                .flatMap((event: OkxTickerEvent) => {
                    const mixedTickers: (Ticker | null)[] = event.tickers
                        .map((trade: OkxTicker) => {
                            return self.createTicker(message.timestamp, trade)
                        })
                    const sklTickers: Ticker[] = mixedTickers.filter((ticker: Ticker | null) => ticker !== null) as Ticker[]
                    return sklTickers
                })
        } else {
            logger.log(`Unhandled public connector event: ${event}`)
            return []
        }
    }

    private updateBook(event: OkxMarketDepthEvent) {
        const self = this
        const eventData = event.updates
        const bidsList = eventData.filter((event: OkxMarketDepthLevel) => event.side === "bid")
        const asksList = eventData.filter((event: OkxMarketDepthLevel) => event.side === "offer")

        // initial orderbook
        if (event.type === "snapshot") {
            self.bids = bidsList
            self.asks = asksList
            // updates for orderbook
        } else {
            // updates for bids
            bidsList.forEach((event: any) => {
                const eventIndex = self.bids.findIndex(bid => bid.price_level === event.price_level)
                // remove existing bid if no more quantity
                if (event.new_quantity === "0" && eventIndex !== -1) {
                    self.bids.splice(eventIndex, 1)
                    // add bid with quantity if not already in array - sorted descending
                } else if (parseFloat(event.new_quantity) > 0 && eventIndex === -1) {
                    self.bids.unshift(event)
                    self.bids.sort((a, b) => parseFloat(b.price_level) - parseFloat(a.price_level))
                }
            })

            // updates for asks
            asksList.forEach((event: any) => {
                const eventIndex = self.asks.findIndex(ask => ask.price_level === event.price_level)
                // remove existing ask
                if (event.new_quantity === "0" && eventIndex !== -1) {
                    self.asks.splice(eventIndex, 1)
                    // add ask with quantity if not already in array - sorted ascending
                } else if (parseFloat(event.new_quantity) > 0 && eventIndex === -1) {
                    self.asks.unshift(event)
                    self.asks.sort((a, b) => parseFloat(a.price_level) - parseFloat(b.price_level))
                }

            })
        }
    }

    private createTopOfBook(timestamp:string): TopOfBook | null {
        const self = this
        if (self.bids.length === 0 || self.asks.length === 0) {
            return null
        }
        return {
            symbol: self.sklSymbol,
            connectorType: 'Okx',
            event: 'TopOfBook',
            timestamp: (new Date(timestamp)).getTime(),
            askPrice: parseFloat(self.asks[0].price_level),
            askSize: parseFloat(self.asks[0].new_quantity),
            bidPrice: parseFloat(self.bids[0].price_level),
            bidSize: parseFloat(self.bids[0].new_quantity),
        };
    }

    private createTicker(timestamp: string, trade: OkxTicker): Ticker {
        const self = this
        return {
            symbol: self.sklSymbol,
            connectorType: 'Okx',
            event: 'Ticker',
            lastPrice: parseFloat(trade.price),
            timestamp: (new Date(timestamp)).getTime(),
        };
    }

    private createTrade(trade: OkxTrade): Trade | null {
        const self = this
        return {
            symbol: self.sklSymbol,
            connectorType: 'Okx',
            event: 'Trade',
            price: parseFloat(trade.price),
            size: parseFloat(trade.size),
            // side: okxSideMap(trade.side),
            timestamp: (new Date(trade.timestamp)).getTime(),
        }
    }

}

 
