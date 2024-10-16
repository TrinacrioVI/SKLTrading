SKL Trading
OKX Exchange

Nunzio Sisto
Nunzio.a.sisto@gmail.com



My goal was to construct the connectors based on the Coinbase 
example, the instructions and the documentation.

They each initialize a WS connection with OKX Exchange. 

The publicwsfeed subscribes to channels for variable updates, 
separating them into Trades, TopOfBook and Ticker events.

The privatewsfeed subscribes to private channels 
for authorized interactions regarding accounts and trades;
the trades being achieved with POST requests, edited with DELETE and GET requests. 

With more time I could thoroughly test and refine all parts. 




