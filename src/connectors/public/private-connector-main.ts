import {ConnectorConfiguration, ConnectorGroup, Credential } from "../../types";
// In private-connector-main.ts
const connectorInstance: PrivateExchangeConnector = ConnectorFactory.getPrivateConnector(
    connectorGroup,
    connectorConfig,
    credential
);