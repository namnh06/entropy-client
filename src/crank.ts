/**
 This will probably move to its own repo at some point but easier to keep it here for now
 */
import * as os from 'os';
import * as fs from 'fs';
import { EntropyClient } from './client';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { getMultipleAccounts, sleep } from './utils';
import configFile from './ids.json';
import { Cluster, Config } from './config';
import BN from 'bn.js';
import {
  decodeEventQueue,
  DexInstructions,
  Market,
} from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {processConsumeEvents} from './keeper'

require('dotenv').config({ path: '.env' });

const interval = 300; // TODO - stop sharing env var with Keeper
const maxUniqueAccounts = parseInt(process.env.MAX_UNIQUE_ACCOUNTS || '10');
const consumeEventsLimit = new BN(process.env.CONSUME_EVENTS_LIMIT || '10');
const config = new Config(configFile);

const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
const groupName = process.env.GROUP || 'mainnet.2';
const groupIds = config.getGroup(cluster, groupName);

if (!groupIds) {
  throw new Error(`Group ${groupName} not found`);
}
const entropyProgramId = groupIds.entropyProgramId;
const entropyGroupKey = groupIds.publicKey;
const payer = new Account(
  JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/entropy-mainnet-authority.json', 'utf-8'),
  ),
);

const connection = new Connection(
  process.argv[2] || process.env.RPC_ENDPOINT || config.cluster_urls[cluster],
  'processed' as Commitment,
);
const client = new EntropyClient(connection, entropyProgramId);
console.log(process.env.RPC_ENDPOINT);
async function run() {
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  const perpMarkets = await Promise.all(
    groupIds.perpMarkets.map((m) => {
      return entropyGroup.loadPerpMarket(
        connection,
        m.marketIndex,
        m.baseDecimals,
        m.quoteDecimals,
      );
    }),
  );

  processConsumeEvents(entropyGroup, perpMarkets, interval);
}

run();
