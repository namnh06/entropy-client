import {
  Cluster,
  Config,
  getPerpMarketByBaseSymbol,
  PerpMarketConfig,
} from './config';
import configFile from './ids.json';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import { EntropyClient } from './client';
import {
  BookSide,
  makeCancelAllPerpOrdersInstruction,
  makePlacePerpOrderInstruction,
  EntropyCache,
  ONE_BN,
  sleep,
} from './index';
import { BN } from 'bn.js';
import EntropyAccount from './EntropyAccount';
import EntropyGroup from './EntropyGroup';
import PerpMarket from './PerpMarket';

const interval = parseInt(process.env.INTERVAL || '10000');
const control = { isRunning: true, interval: interval };

async function mm() {
  // load entropy group and clients
  const config = new Config(configFile);
  const groupName = process.env.GROUP || 'devnet.2';
  const entropyAccountName = process.env.MANGO_ACCOUNT_NAME;

  const groupIds = config.getGroupWithName(groupName);
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  const cluster = groupIds.cluster as Cluster;
  const entropyProgramId = groupIds.entropyProgramId;
  const entropyGroupKey = groupIds.publicKey;

  const payer = new Account(
    JSON.parse(
      fs.readFileSync(
        process.env.KEYPAIR ||
          os.homedir() + '/.config/solana/entropy-mainnet-authority.json',
        'utf-8',
      ),
    ),
  );
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  const connection = new Connection(
    process.env.RPC_ENDPOINT || config.cluster_urls[cluster],
    'confirmed' as Commitment,
  );
  const client = new EntropyClient(connection, entropyProgramId);

  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

  const ownerAccounts = await client.getEntropyAccountsForOwner(
    entropyGroup,
    payer.publicKey,
    true,
  );

  let entropyAccountPk;
  if (entropyAccountName) {
    for (const ownerAccount of ownerAccounts) {
      if (entropyAccountName === ownerAccount.name) {
        entropyAccountPk = ownerAccount.publicKey;
        break;
      }
    }
    if (!entropyAccountPk) {
      throw new Error('MANGO_ACCOUNT_NAME not found');
    }
  } else {
    const entropyAccountPkStr = process.env.MANGO_ACCOUNT_PUBKEY;
    if (!entropyAccountPkStr) {
      throw new Error(
        'Please add env variable MANGO_ACCOUNT_PUBKEY or MANGO_ACCOUNT_NAME',
      );
    } else {
      entropyAccountPk = new PublicKey(entropyAccountPkStr);
    }
  }

  // TODO make it be able to quote all markets
  const marketName = process.env.MARKET;
  if (!marketName) {
    throw new Error('Please add env variable MARKET');
  }

  const perpMarketConfig = getPerpMarketByBaseSymbol(
    groupIds,
    marketName.toUpperCase(),
  ) as PerpMarketConfig;
  const marketIndex = perpMarketConfig.marketIndex;
  const perpMarket = await client.getPerpMarket(
    perpMarketConfig.publicKey,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  const sizePerc = parseFloat(process.env.SIZE_PERC || '0.1');
  const charge = parseFloat(process.env.CHARGE || '0.0010');
  const leanCoeff = parseFloat(process.env.LEAN_COEFF || '0.0005');
  const bias = parseFloat(process.env.BIAS || '0.0');
  const requoteThresh = parseFloat(process.env.REQUOTE_THRESH || '0.0');
  const takeSpammers = process.env.TAKE_SPAMMERS === 'true';

  const spammerCharge = parseFloat(process.env.SPAMMER_CHARGE || '2'); // multiplier on charge

  process.on('SIGINT', function () {
    console.log('Caught keyboard interrupt. Canceling orders');
    control.isRunning = false;
    onExit(
      client,
      payer,
      entropyProgramId,
      entropyGroup,
      perpMarket,
      entropyAccountPk,
    );
  });

  while (control.isRunning) {
    try {
      // get fresh data
      // get orderbooks, get perp markets, caches
      // TODO load pyth oracle itself for most accurate prices
      const [bids, asks, entropyCache, entropyAccount]: [
        BookSide,
        BookSide,
        EntropyCache,
        EntropyAccount,
      ] = await Promise.all([
        perpMarket.loadBids(connection),
        perpMarket.loadAsks(connection),
        entropyGroup.loadCache(connection),
        client.getEntropyAccount(entropyAccountPk, entropyGroup.dexProgramId),
      ]);

      // TODO store the prices in an array to calculate volatility

      // Model logic
      const fairValue = entropyGroup
        .getPrice(marketIndex, entropyCache)
        .toNumber();
      const equity = entropyAccount
        .computeValue(entropyGroup, entropyCache)
        .toNumber();
      const perpAccount = entropyAccount.perpAccounts[marketIndex];
      // TODO look at event queue as well for unprocessed fills
      const basePos = perpAccount.getBasePositionUi(perpMarket);

      // TODO volatility adjustment
      const size = (equity * sizePerc) / fairValue;
      const lean = (-leanCoeff * basePos) / size;
      const bidPrice = fairValue * (1 - charge + lean + bias);
      const askPrice = fairValue * (1 + charge + lean + bias);

      const [modelBidPrice, nativeBidSize] = perpMarket.uiToNativePriceQuantity(
        bidPrice,
        size,
      );
      const [modelAskPrice, nativeAskSize] = perpMarket.uiToNativePriceQuantity(
        askPrice,
        size,
      );

      const bestBid = bids.getBest();
      const bestAsk = asks.getBest();

      const bookAdjBid =
        bestAsk !== undefined
          ? BN.min(bestAsk.priceLots.sub(ONE_BN), modelBidPrice)
          : modelBidPrice;
      const bookAdjAsk =
        bestBid !== undefined
          ? BN.max(bestBid.priceLots.add(ONE_BN), modelAskPrice)
          : modelAskPrice;

      // TODO use order book to requote if size has changed
      const openOrders = entropyAccount
        .getPerpOpenOrders()
        .filter((o) => o.marketIndex === marketIndex);
      let moveOrders = openOrders.length === 0 || openOrders.length > 2;
      for (const o of openOrders) {
        console.log(
          `${o.side} ${o.price.toString()} -> ${
            o.side === 'buy' ? bookAdjBid.toString() : bookAdjAsk.toString()
          }`,
        );

        if (o.side === 'buy') {
          if (
            Math.abs(o.price.toNumber() / bookAdjBid.toNumber() - 1) >
            requoteThresh
          ) {
            moveOrders = true;
          }
        } else {
          if (
            Math.abs(o.price.toNumber() / bookAdjAsk.toNumber() - 1) >
            requoteThresh
          ) {
            moveOrders = true;
          }
        }
      }

      // Start building the transaction
      const tx = new Transaction();

      /*
      Clear 1 lot size orders at the top of book that bad people use to manipulate the price
       */
      if (
        takeSpammers &&
        bestBid !== undefined &&
        bestBid.sizeLots.eq(ONE_BN) &&
        bestBid.priceLots.toNumber() / modelAskPrice.toNumber() - 1 >
          spammerCharge * charge + 0.0005
      ) {
        console.log(`${marketName}-PERP taking best bid spammer`);
        const takerSell = makePlacePerpOrderInstruction(
          entropyProgramId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          payer.publicKey,
          entropyCache.publicKey,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          perpMarket.eventQueue,
          entropyAccount.getOpenOrdersKeysInBasket(),
          bestBid.priceLots,
          ONE_BN,
          new BN(Date.now()),
          'sell',
          'ioc',
        );
        tx.add(takerSell);
      } else if (
        takeSpammers &&
        bestAsk !== undefined &&
        bestAsk.sizeLots.eq(ONE_BN) &&
        modelBidPrice.toNumber() / bestAsk.priceLots.toNumber() - 1 >
          spammerCharge * charge + 0.0005
      ) {
        console.log(`${marketName}-PERP taking best ask spammer`);
        const takerBuy = makePlacePerpOrderInstruction(
          entropyProgramId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          payer.publicKey,
          entropyCache.publicKey,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          perpMarket.eventQueue,
          entropyAccount.getOpenOrdersKeysInBasket(),
          bestAsk.priceLots,
          ONE_BN,
          new BN(Date.now()),
          'buy',
          'ioc',
        );
        tx.add(takerBuy);
      }
      if (moveOrders) {
        // cancel all, requote
        const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
          entropyProgramId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          payer.publicKey,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          new BN(20),
        );

        const placeBidInstr = makePlacePerpOrderInstruction(
          entropyProgramId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          payer.publicKey,
          entropyCache.publicKey,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          perpMarket.eventQueue,
          entropyAccount.getOpenOrdersKeysInBasket(),
          bookAdjBid,
          nativeBidSize,
          new BN(Date.now()),
          'buy',
          'postOnlySlide',
        );

        const placeAskInstr = makePlacePerpOrderInstruction(
          entropyProgramId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          payer.publicKey,
          entropyCache.publicKey,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          perpMarket.eventQueue,
          entropyAccount.getOpenOrdersKeysInBasket(),
          bookAdjAsk,
          nativeAskSize,
          new BN(Date.now()),
          'sell',
          'postOnlySlide',
        );
        tx.add(cancelAllInstr);
        tx.add(placeBidInstr);
        tx.add(placeAskInstr);
      } else {
        console.log(`${marketName}-PERP Not requoting. No need to move orders`);
      }
      if (tx.instructions.length > 0) {
        const txid = await client.sendTransaction(tx, payer, []);
        console.log(
          `${marketName}-PERP adjustment success: ${txid.toString()}`,
        );
      }
    } catch (e) {
      // sleep for some time and retry
      console.log(e);
    } finally {
      console.log(`sleeping for ${interval / 1000}s`);
      await sleep(interval);
    }
  }
}

async function onExit(
  client: EntropyClient,
  payer: Account,
  entropyProgramId: PublicKey,
  entropyGroup: EntropyGroup,
  perpMarket: PerpMarket,
  entropyAccountPk: PublicKey,
) {
  await sleep(control.interval);
  const entropyAccount = await client.getEntropyAccount(
    entropyAccountPk,
    entropyGroup.dexProgramId,
  );

  const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
    entropyProgramId,
    entropyGroup.publicKey,
    entropyAccount.publicKey,
    payer.publicKey,
    perpMarket.publicKey,
    perpMarket.bids,
    perpMarket.asks,
    new BN(20),
  );
  const tx = new Transaction();
  tx.add(cancelAllInstr);

  const txid = await client.sendTransaction(tx, payer, []);
  console.log(`cancel successful: ${txid.toString()}`);

  process.exit();
}

function startMarketMaker() {
  if (control.isRunning) {
    mm().finally(startMarketMaker);
  }
}

process.on('unhandledRejection', function (err, promise) {
  console.error(
    'Unhandled rejection (promise: ',
    promise,
    ', reason: ',
    err,
    ').',
  );
});

startMarketMaker();
