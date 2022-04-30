import fs from 'fs';
import os from 'os';
import { Cluster, Config, EntropyClient, sleep } from '../src';
import configFile from '../src/ids.json';
import { Account, Commitment, Connection } from '@solana/web3.js';

async function testAccounts() {
  // Load all the details for entropy group
  const groupName = process.env.GROUP || 'mainnet.2';
  const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
  const sleepTime = 250;
  const config = new Config(configFile);
  const groupIds = config.getGroup(cluster, groupName);
  const accounts = 10000;

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
    config.cluster_urls[cluster],
    'processed' as Commitment,
  );

  const client = new EntropyClient(connection, entropyProgramId);
  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

  for (let i = 0; i < accounts; i++) {
    try {
      await client.initEntropyAccount(entropyGroup, payer);
      console.log(`Created account ${i}/${accounts}`);
    } catch (err) {
      console.error('Failed to create account');
    } finally {
      await sleep(sleepTime);
    }
  }
}

testAccounts();
