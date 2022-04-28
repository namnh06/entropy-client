#!/usr/bin/env node
// TODO put node banks and vaults inside the GroupConfig
import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import {
  Cluster,
  Config,
  getPerpMarketByBaseSymbol,
  getPerpMarketByIndex,
  getTokenBySymbol,
  GroupConfig,
  PerpMarketConfig,
  getMarketByBaseSymbolAndKind,
} from './config';

import { EntropyClient } from './client';
import { throwUndefined, uiToNative } from './utils';
import {
    QUOTE_INDEX,
    EntropyCache,
} from './layout';
import EntropyGroup from './EntropyGroup';
import {
    PerpMarket
} from '.'


import { BN } from 'bn.js';
import {readConfig, openConnection} from './cli'

export const CRAB_PUBKEY = 'VKH3Tf7yAgxU5JKkuU7HLmrYCvnGM2LKsPL9bvgRHq3';

/* Gets the midpoint of any given market*/
async function getMidpoint(symbol: string, entropyGroup: EntropyGroup, groupConfig: GroupConfig, connection: Connection, entropyCache: EntropyCache, impactQuantity: number) {
    const IMPACT_QUANTITY = new BN(10000);
    const perpMarketConfig = getMarketByBaseSymbolAndKind(
        groupConfig,
        symbol,
        'perp',
    );
    const perpMarket = await entropyGroup.loadPerpMarket(
        connection,
        perpMarketConfig.marketIndex,
        perpMarketConfig.baseDecimals,
        perpMarketConfig.quoteDecimals,
    );
    const oraclePrice = entropyCache.priceCache[perpMarketConfig.marketIndex].price;
    const bids = await perpMarket.loadBids(connection);
    const asks = await perpMarket.loadAsks(connection);
    const bid = bids.getImpactPriceUi(IMPACT_QUANTITY) || oraclePrice.toNumber();
    const ask = asks.getImpactPriceUi(IMPACT_QUANTITY) || oraclePrice.toNumber();
    return (bid+ask)/2;
}

/*This function calculates the net delta exposure of the Crab Volt by taking the base position of BTC*/
export async function getCrabDelta(symbol: string, pubkey:string=CRAB_PUBKEY) {
    const config = readConfig(__dirname+'/ids.json' as string);
    const symbolSq = symbol+"^2";

    // Establish connection, gather metadata, caches, and configs
    const groupConfig = config.getGroupWithName(
        'mainnet.2' as string,
    ) as GroupConfig;

    const connection = openConnection(config, groupConfig.cluster);
    const client = new EntropyClient(connection, groupConfig.entropyProgramId);
    const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);
    const entropyAccount = await client.getEntropyAccount(
        new PublicKey(pubkey),
        entropyGroup.dexProgramId
    );
    const entropyCache = await entropyGroup.loadCache(connection);
    const perpMid = await getMidpoint(symbol, entropyGroup, groupConfig, connection, entropyCache, 10000);
    const sqMid = await getMidpoint(symbolSq, entropyGroup, groupConfig, connection, entropyCache, 10000);

    console.log(perpMid, sqMid);


    const quoteAdj = new BN(10).pow(
        new BN(entropyGroup.tokens[QUOTE_INDEX].decimals),
      );

    const equity = entropyAccount.computeValue(entropyGroup, entropyCache).toNumber();
    console.log("Crab Account Equity: ", equity);

    const sqMarketIndex: number = throwUndefined(
        getPerpMarketByBaseSymbol(groupConfig, symbolSq as string),
      ).marketIndex;

    const perpMarketIndex: number = throwUndefined(
    getPerpMarketByBaseSymbol(groupConfig, symbol as string),
    ).marketIndex;

    const sqBase = entropyAccount.getBasePositionUiWithGroup(
            sqMarketIndex,
            entropyGroup,
    );
    const base = entropyAccount.getBasePositionUiWithGroup(
            perpMarketIndex,
            entropyGroup,
    );
    const delta = (sqBase*sqMid*2+ base*perpMid)/equity;
    console.log("Delta: ", delta);
    return delta
}


// export async function getTrades() {
//     const config = readConfig(__dirname+'/ids.json' as string);
//     const groupConfig = config.getGroupWithName(
//         'mainnet.2' as string,
//     ) as GroupConfig;

//     const connection = openConnection(config, groupConfig.cluster);

//     const client = new EntropyClient(connection, groupConfig.entropyProgramId);
//     const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);
//     const perpMarket = entropyGroup.perpMarkets[0];
//     const btcMarket = getPerpMarketByIndex(groupConfig, 0) as PerpMarketConfig;

//     const pm = await client.getPerpMarket(
//         perpMarket.perpMarket,
//         btcMarket.baseDecimals,
//         btcMarket.quoteDecimals,
//     );

//     const fills = await pm.loadFills(connection);
//     console.log(fills);
//     console.log(fills.length);


// }
getCrabDelta("BTC");