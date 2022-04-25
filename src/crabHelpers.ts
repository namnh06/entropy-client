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
} from './config';
import { EntropyClient } from './client';
import { throwUndefined, uiToNative } from './utils';
import { QUOTE_INDEX } from './layout';

import { BN } from 'bn.js';
import {readConfig, openConnection} from './cli'

export const CRAB_PUBKEY = 'VKH3Tf7yAgxU5JKkuU7HLmrYCvnGM2LKsPL9bvgRHq3';

export async function getCrabDelta() {
    const config = readConfig(__dirname+'/ids.json' as string);
    const groupConfig = config.getGroupWithName(
        'mainnet.2' as string,
    ) as GroupConfig;

    const connection = openConnection(config, groupConfig.cluster);

    const client = new EntropyClient(connection, groupConfig.entropyProgramId);
    const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);
    const entropyAccount = await client.getEntropyAccount(
        new PublicKey(CRAB_PUBKEY),
        entropyGroup.dexProgramId
    );
    const entropyCache = await entropyGroup.loadCache(connection);

    const quoteAdj = new BN(10).pow(
        new BN(entropyGroup.tokens[QUOTE_INDEX].decimals),
      );

    const equity = entropyAccount.computeValue(entropyGroup, entropyCache).toNumber();
    console.log("Crab Account Equity: ", equity);

    const btc2MarketIndex: number = throwUndefined(
        getPerpMarketByBaseSymbol(groupConfig, 'BTC^2' as string),
      ).marketIndex;

    const btcMarketIndex: number = throwUndefined(
    getPerpMarketByBaseSymbol(groupConfig, 'BTC' as string),
    ).marketIndex;

    const btc2PerpAccount = entropyAccount.perpAccounts[btc2MarketIndex];
    const btc2Quote = btc2PerpAccount.getQuotePosition(
        entropyCache.perpMarketCache[btc2MarketIndex]
    ).toNumber() / quoteAdj.toNumber();
    const btc2Funding = btc2PerpAccount.getUnsettledFunding(
        entropyCache.perpMarketCache[btc2MarketIndex]
    ).toNumber() / quoteAdj.toNumber();
    // Assumes we are always long the BTC^2 Position
    const btc2TotalPos = btc2Quote+btc2Funding;


    const btcPerpAccount = entropyAccount.perpAccounts[btcMarketIndex];
    const btcQuote = btcPerpAccount.getQuotePosition(
        entropyCache.perpMarketCache[btcMarketIndex]
    ).toNumber() / quoteAdj.toNumber();
    const btcFunding = btcPerpAccount.getUnsettledFunding(
        entropyCache.perpMarketCache[btcMarketIndex]
    ).toNumber() / quoteAdj.toNumber();
    // Assumes we are always short the BTC position.
    const btcTotalPos = btcQuote-btcFunding;
    const delta = (btc2TotalPos*2+btcTotalPos)/equity;
    console.log("Delta: ", delta);
    return delta

}