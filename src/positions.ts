import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { group } from 'console';
import { EntropyClient } from './client';
import { Cluster, Config } from './config';

const config = Config.ids();
const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
const connection = new Connection(
  config.cluster_urls[cluster],
  'processed' as Commitment,
);

const groupName = process.env.GROUP || 'mainnet.2';
const groupIds = config.getGroup(cluster, groupName);
if (!groupIds) {
  throw new Error(`Group ${groupName} not found`);
}

const dexProgramId = groupIds.serumProgramId;
const entropyProgramId = groupIds.entropyProgramId;
const entropyGroupKey = groupIds.publicKey;
const client = new EntropyClient(connection, entropyProgramId);

async function watchAccount(pk: PublicKey) {
  const group = await client.getEntropyGroup(entropyGroupKey);
  const account = await client.getEntropyAccount(pk, dexProgramId);
  const cache = await group.loadCache(connection);
  console.log(account.toPrettyString(groupIds!, group, cache));
  console.log('Assets:', account.getAssetsVal(group, cache).toString());
  console.log('Liabs:', account.getLiabsVal(group, cache).toString());
}

async function watchHighestLiabilities(n: number) {
  console.log('getEntropyGroup');
  const group = await client.getEntropyGroup(entropyGroupKey);
  console.log('getAllEntropyAccounts');
  const entropyAccounts = await client.getAllEntropyAccounts(group);
  console.log('loadCache');
  const cache = await group.loadCache(connection);

  entropyAccounts.sort((a, b) => {
    const aLiabs = a.getLiabsVal(group, cache, 'Maint');
    const bLiabs = b.getLiabsVal(group, cache, 'Maint');
    return bLiabs.sub(aLiabs).toNumber();
  });

  for (let i = 0; i < Math.min(n, entropyAccounts.length); i++) {
    console.log(i);
    console.log(entropyAccounts[i].toPrettyString(groupIds!, group, cache));
  }
}

if (process.env.ACC) {
  watchAccount(new PublicKey(process.env.ACC));
} else {
  watchHighestLiabilities(30);
}
