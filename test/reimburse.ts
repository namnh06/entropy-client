/**
 * This script was used to reimburse accounts affected by Dec 4 MSOL oracle incident
 */

import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import {
  Config,
  findLargestTokenAccountForOwner,
  GroupConfig,
  IDS,
  EntropyClient,
  QUOTE_INDEX,
  RootBank,
} from '../src';

const config = new Config(IDS);

const payer = new Account(
  JSON.parse(
    fs.readFileSync(
      process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json',
      'utf-8',
    ),
  ),
);

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

const accountReimbursements = [
  {
    entropyAccountPubkey: '2djENyoL1HhRj3dELXv2N5z6buuyinrGfTd7Dn9asvST',
    amount: 76723.12,
  },
  {
    entropyAccountPubkey: '2nxUQGyysW7FB7apwjkFdnReZq2bA1JmgqT67fdaRUTE',
    amount: 2056.63,
  },
  {
    entropyAccountPubkey: '62tjaFUr1cjTyHbZWzo6UW2NYEmuXzxWdLZhJ7mMxUxw',
    amount: 10436.11,
  },
];

async function reimburse() {
  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);
  const rootBanks = await entropyGroup.loadRootBanks(connection);
  const quoteRootBank = rootBanks[QUOTE_INDEX] as RootBank;
  const nodeBank = quoteRootBank.nodeBankAccounts[0];

  const quoteTokenAccount = await findLargestTokenAccountForOwner(
    connection,
    payer.publicKey,
    entropyGroup.tokens[QUOTE_INDEX].mint,
  );

  for (const info of accountReimbursements) {
    const entropyAccount = await client.getEntropyAccount(
      new PublicKey(info.entropyAccountPubkey),
      entropyGroup.dexProgramId,
    );

    const txid = await client.deposit(
      entropyGroup,
      entropyAccount,
      payer,
      quoteRootBank.publicKey,
      nodeBank.publicKey,
      nodeBank.vault,
      quoteTokenAccount.publicKey,
      info.amount,
    );
    console.log(
      `txid: ${txid.toString()}\nSuccessfully reimbursed ${
        info.amount
      } to ${entropyAccount.publicKey.toBase58()}.`,
    );
  }
}

reimburse();
