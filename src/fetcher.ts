import { EntropyClient } from './client';
import {
  Commitment,
  Connection
} from '@solana/web3.js';
import { sleep } from './utils';
import configFile from './ids.json';
import {
  Cluster,
  Config,
  getPerpMarketByBaseSymbol,
  PerpMarketConfig
} from './config';
import { ONE_BN, ZERO_BN } from '.';

export class Fetcher {
  /**
   * Long running program that never exits except on keyboard interrupt
   */
  async run() {
    const interval = process.env.INTERVAL || 5000;
    const config = new Config(configFile);

    // defaults to mainnet since there's more going on there
    const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
    const groupName = process.env.GROUP || 'mainnet.2';
    const groupIds = config.getGroup(cluster, groupName);

    if (!groupIds) {
      throw new Error(`Group ${groupName} not found`);
    }

    const entropyProgramId = groupIds.entropyProgramId;
    const entropyGroupKey = groupIds.publicKey;

    // we don't need to load a solana Account; we're not gonna be signing anything

    const connection = new Connection(
      process.env.RPC_ENDPOINT || config.cluster_urls[cluster],
      'processed' as Commitment,
    );
    const client = new EntropyClient(connection, entropyProgramId);
    const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

    const marketName = process.env.MARKET || 'MNGO';

    const perpMarketConfig = getPerpMarketByBaseSymbol(
      groupIds,
      marketName.toUpperCase(),
    ) as PerpMarketConfig;

    if (!perpMarketConfig) {
      throw new Error(`Couldn't find market: ${marketName.toUpperCase()}`);
    }

    const marketIndex = perpMarketConfig.marketIndex;
    const mk = groupIds.perpMarkets[marketIndex];

    const perpMarket = await entropyGroup.loadPerpMarket(
      connection,
      mk.marketIndex,
      mk.baseDecimals,
      mk.quoteDecimals,
    );

    let lastSeqNum = ZERO_BN;
    // eslint-disable-next-line
    while (true) {
      await sleep(interval);
      const queue = await perpMarket.loadEventQueue(connection);
      console.log(queue.eventsSince(lastSeqNum));
      // -1 here since queue.seqNum is the seqNum for the next (future) event
      lastSeqNum = queue.seqNum.sub(ONE_BN);
    }
  }
}

new Fetcher().run();
