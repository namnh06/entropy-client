import configFile from './ids.json';
import { Cluster, Config, GroupConfig } from './config';
import { findPerpMarketParams } from './utils';
import { EntropyClient } from './client';
import { Commitment, Connection } from '@solana/web3.js';
import { QUOTE_INDEX } from './layout';

async function main() {
  const config = new Config(configFile);
  const groupName = process.env.GROUP || 'mainnet.2';
  const groupIds = config.getGroupWithName(groupName) as GroupConfig;
  const cluster = groupIds.cluster;
  const entropyProgramId = groupIds.entropyProgramId;
  const entropyGroupKey = groupIds.publicKey;
  const connection = new Connection(
    process.env.RPC_ENDPOINT || config.cluster_urls[cluster],
    'processed' as Commitment,
  );
  const client = new EntropyClient(connection, entropyProgramId);
  const group = await client.getEntropyGroup(entropyGroupKey);

  // AVAX-PERP
  const avaxParams = findPerpMarketParams(
    18,
    group.tokens[QUOTE_INDEX].decimals,
    85,
    10,
    500,
  );
  console.log('AVAX params:', avaxParams);

  // BNB-PERP
  const bnbParams = findPerpMarketParams(
    18,
    group.tokens[QUOTE_INDEX].decimals,
    568,
    10,
    500,
  );

  console.log('BNB params:', bnbParams);

  // MATIC-PERP
  const maticParams = findPerpMarketParams(
    18,
    group.tokens[QUOTE_INDEX].decimals,
    2.22,
    10,
    500,
  );
  console.log('MATIC params:', maticParams);

  // LUNA-PERP
  const lunaParams = findPerpMarketParams(
    6,
    group.tokens[QUOTE_INDEX].decimals,
    85,
    10,
    500,
  );
  console.log('LUNA params:', lunaParams);

  // DOT-PERP
  const dotParams = findPerpMarketParams(
    10,
    group.tokens[QUOTE_INDEX].decimals,
    64,
    10,
    500,
  );
  console.log('DOT params:', dotParams);
}

main();
