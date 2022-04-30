import * as os from 'os';
import * as fs from 'fs';
import { EntropyClient } from './client';
import { Account, Commitment, Connection } from '@solana/web3.js';
import configFile from './ids.json';
import { Config, getMarketByBaseSymbolAndKind, GroupConfig } from './config';
import { Market } from '@project-serum/serum';
import { ZERO_BN } from './utils';
import EntropyGroup from './EntropyGroup';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/entropy-mainnet-authority.json', 'utf-8'),
  );
}

function readKeypair_opp() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf-8'),
  );
}

async function checkPrice() {
  // setup client
  const config = new Config(configFile);
  const groupConfig = config.getGroup(
    'devnet',
    'devnet.2',
  ) as GroupConfig;
  const connection = new Connection(
    'https://api.devnet.solana.com',
    'processed' as Commitment,
  );
  const client = new EntropyClient(connection, groupConfig.entropyProgramId);
  const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);

  console.log('group key = ', groupConfig.publicKey.toString());

  console.log('tokens: ', entropyGroup.tokens);
  // console.log('spot markets: ', entropyGroup.spotMarkets);
  // console.log('perp markets: ', entropyGroup.perpMarkets);

  // load group & market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    'SOL',
    'perp',
  );

  const perpMarket = await entropyGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  console.log("INDEX: ",perpMarketConfig.marketIndex);
  console.log("MARKET INFO: ", perpMarket.toPrettyString(entropyGroup, perpMarketConfig));
  // Fetch orderbooks
  const bids = await perpMarket.loadBids(connection);
  const asks = await perpMarket.loadAsks(connection);

  // Load Cache
  const entropyCache = await entropyGroup.loadCache(connection);

  console.log("CACHE SHIT: ", entropyCache.priceCache[7].lastUpdate.toString());

  // Load funding rate
  const funding_rate = await perpMarket.getCurrentFundingRate(entropyGroup, entropyCache, perpMarketConfig.marketIndex, bids, asks);
  console.log("FUNDING RATE: ", funding_rate.toString());

  // Load price
  console.log("DECIMALS: ", entropyGroup.getTokenDecimals(perpMarketConfig.marketIndex));
  console.log("RAW PRICE: ", entropyCache.priceCache[perpMarketConfig.marketIndex].price.toString())
  console.log("UI PRICE: ", entropyGroup.getPriceUi(perpMarketConfig.marketIndex, entropyCache).toString());
  const price = entropyCache.priceCache[perpMarketConfig.marketIndex].price
  console.log("CACHE TO UI PRICE: ", entropyGroup.cachePriceToUi(price, perpMarketConfig.marketIndex))
  // console.log('prices = ', entropyCache.priceCache);
  }

checkPrice();
