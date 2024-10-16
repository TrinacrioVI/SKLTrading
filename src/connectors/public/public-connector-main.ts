import {ConnectorConfiguration, ConnectorGroup, Credential } from "../../types";
// In public-connector-main.ts
const connectorInstance: PublicExchangeConnector = ConnectorFactory.getPublicConnector(
    connectorGroup,
    connectorConfig,
    credential
);