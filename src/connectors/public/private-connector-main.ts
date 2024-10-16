import {ConnectorConfiguration, ConnectorGroup, Credential, ConnectorFactory } from "../../types";
// In Private-connector-main.ts
const connectorInstance: PrivateExchangeConnector = ConnectorFactory.getPrivateConnector(
    ConnectorGroup,
    ConnectorConfiguration,
    Credential
);