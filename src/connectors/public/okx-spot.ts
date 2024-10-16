import { ConnectorConfiguration, ConnectorGroup, Side } from "../../types"

export type OkxTradeSide = 'BUY' | 'SELL' | undefined

export const OkxSideMap: { [key: string]: Side } = {
    'BUY': 'Buy',
    'SELL': 'Sell'
}

export const OkxInvertedSideMap: { [key: string]: OkxSide } = {
    'Buy': 'BUY',
    'Sell': 'SELL'
}

export const getOkxSymbol = (symbolGroup: ConnectorGroup, connectorConfig: ConnectorConfiguration): string => {
    return `${symbolGroup.name}${connectorConfig.quoteAsset}`
}