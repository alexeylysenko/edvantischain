/*!
	Edvantis training simple blockchain
*/

'use strict';
var cryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var webSocket = require("ws");

var httpPort = process.env.HTTP_PORT || 8001;
var p2pPort = process.env.P2P_PORT || 7001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {
    constructor(index, timestamp, data, hash, previousHash) {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.previousHash = previousHash.toString();
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST_BLOCK: 0,
    QUERY_BLOCKCHAIN: 1,
    RESPONSE_BLOCKCHAIN: 2
};

var calculateHash = (index, timestamp, data, previousHash) => {
    return cryptoJS.SHA256(index + timestamp + data + previousHash).toString();
};

var getGenesisBlock = () => {
	var timestamp = 1521013323;
	var hash = calculateHash(0, timestamp, "Genesis block", "0");
    return new Block(0, timestamp, "Genesis block", hash, "0");
};

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get("/blockchain", (req, res) => res.send(JSON.stringify(blockchain)));
    app.post("/addBlock", (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestBlockMsg());
        console.log("New block was added: " + JSON.stringify(newBlock));
        res.send();
    });
    app.get("/peers", (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ":" + s._socket.remotePort));
    });
    app.post("/addPeer", (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(httpPort, () => console.log("HTTP server is listening on port: " + httpPort));
};

var initP2PServer = () => {
    var server = new webSocket.Server({port: p2pPort});
    server.on("connection", ws => initConnection(ws));
    console.log("P2P websocket server is listening on port: " + p2pPort);
};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
	ws.send(JSON.stringify(queryBlockchainLengthMsg()));
};

var initMessageHandler = (ws) => {
    ws.on("message", (data) => {
        var message = JSON.parse(data);
        console.log("Received message " + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST_BLOCK:
				ws.send(JSON.stringify(responseLatestBlockMsg()));
                break;
            case MessageType.QUERY_BLOCKCHAIN:
				ws.send(JSON.stringify(responseBlockchainMsg()));
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log("Unable to connect to peer: " + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on("close", () => closeConnection(ws));
    ws.on("error", () => closeConnection(ws));
};

var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(nextIndex, nextTimestamp, blockData, previousBlock.hash);
    return new Block(nextIndex, nextTimestamp, blockData, nextHash, previousBlock.hash);
};

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.timestamp, block.data, block.previousHash);
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log("Index is invalid");
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log("Previous hash is invalid");
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log('Hash is invalid: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new webSocket(peer);
        ws.on("open", () => initConnection(ws));
        ws.on("error", () => {
            console.log("Unable to connect to peer: " + peer);
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log("Blockchain is possibly behind. Ours: " + latestBlockHeld.index + " peer's: " + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("Appending the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestBlockMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("Querying the entire chain from our peer");
            broadcast(queryBlockchainMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceBlockchain(receivedBlocks);
        }
    } else {
        console.log("Received blockchain is not longer than current blockchain. Do nothing");
    }
};

var replaceBlockchain = (newBlocks) => {
    if (isValidBlockchain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log("Received blockchain is valid. Replacing current blockchain with received one");
        blockchain = newBlocks;
        broadcast(responseLatestBlockMsg());
    } else {
        console.log("Received blockchain is invalid");
    }
};

var isValidBlockchain = (blockchain) => {
    if (JSON.stringify(blockchain[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchain[0]];
    for (var i = 1; i < blockchain.length; i++) {
        if (isValidNewBlock(blockchain[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchain[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryBlockchainLengthMsg = () => ({"type": MessageType.QUERY_LATEST_BLOCK});
var queryBlockchainMsg = () => ({"type": MessageType.QUERY_BLOCKCHAIN});
var responseBlockchainMsg = () =>({
    "type": MessageType.RESPONSE_BLOCKCHAIN, "data": JSON.stringify(blockchain)
});
var responseLatestBlockMsg = () => ({
    "type": MessageType.RESPONSE_BLOCKCHAIN,
    "data": JSON.stringify([getLatestBlock()])
});

var broadcast = (message) => sockets.forEach(socket => socket.send(JSON.stringify(message)));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();