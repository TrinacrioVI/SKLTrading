import {ConnectorConfiguration, ConnectorGroup, Credential, ConnectorFactory } from "../../types";
// In public-connector-main.ts
const connectorInstance: PublicExchangeConnector = ConnectorFactory.getPublicConnector(
    ConnectorGroup,
    ConnectorConfiguration,
    Credential
);