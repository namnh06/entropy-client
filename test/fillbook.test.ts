import {
  Cluster,
  Config,
  findLargestTokenAccountForOwner,
  getPerpMarketByIndex,
  NodeBank,
  PerpMarketConfig,
  QUOTE_INDEX,
  RootBank,
} from '../src';
import configFile from '../src/ids.json';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import { EntropyClient } from '../src';
import {
  makeCancelAllPerpOrdersInstruction,
  makePlacePerpOrderInstruction,
  EntropyCache,
  sleep,
} from '../src';
import { BN } from 'bn.js';
import EntropyAccount from '../src/EntropyAccount';

async function fillBook() {
  // load entropy group and clients
  const config = new Config(configFile);
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const groupName = process.env.GROUP || 'devnet.2';
  const groupIds = config.getGroup(cluster, groupName);
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }

  const entropyProgramId = groupIds.entropyProgramId;
  const entropyGroupKey = groupIds.publicKey;

  const payer = new Account(
    JSON.parse(
      fs.readFileSync(
        process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json',
        'utf-8',
      ),
    ),
  );
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  const connection = new Connection(
    process.env.RPC_ENDPOINT || config.cluster_urls[cluster],
    'processed' as Commitment,
  );
  const client = new EntropyClient(connection, entropyProgramId);

  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

  const marketIndex = 1;
  const perpMarketConfig = getPerpMarketByIndex(
    groupIds,
    marketIndex,
  ) as PerpMarketConfig;
  const perpMarket = await client.getPerpMarket(
    perpMarketConfig.publicKey,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  const quoteTokenInfo = entropyGroup.getQuoteTokenInfo();
  const quoteTokenAccount = await findLargestTokenAccountForOwner(
    connection,
    payer.publicKey,
    quoteTokenInfo.mint,
  );
  const rootBank = (await entropyGroup.loadRootBanks(connection))[
    QUOTE_INDEX
  ] as RootBank;
  const nodeBank = rootBank.nodeBankAccounts[0] as NodeBank;
  const cache = await entropyGroup.loadCache(connection);
  // for (let i = 0; i < 3; i++) {
  //   const entropyAccountStr = await client.initEntropyAccountAndDeposit(
  //     entropyGroup,
  //     payer,
  //     quoteTokenInfo.rootBank,
  //     nodeBank.publicKey,
  //     nodeBank.vault,
  //     quoteTokenAccount.publicKey,
  //     1000,
  //     `testfunding${i}`,
  //   );
  //   const entropyAccountPk = new PublicKey(entropyAccountStr);
  //   const entropyAccount = await client.getEntropyAccount(
  //     entropyAccountPk,
  //     entropyGroup.dexProgramId,
  //   );
  //   for (let j = 0; j < 1; j++) {
  //     for (let k = 0; k < 32; k++) {
  //       const tx = new Transaction();
  //
  //       const [nativeBidPrice, nativeBidSize] =
  //         perpMarket.uiToNativePriceQuantity(100000, 0.0001);
  //       const [nativeAskPrice, nativeAskSize] =
  //         perpMarket.uiToNativePriceQuantity(1, 0.0001);
  //
  //       const placeBidInstruction = makePlacePerpOrderInstruction(
  //         entropyProgramId,
  //         entropyGroup.publicKey,
  //         entropyAccount.publicKey,
  //         payer.publicKey,
  //         entropyGroup.entropyCache,
  //         perpMarket.publicKey,
  //         perpMarket.bids,
  //         perpMarket.asks,
  //         perpMarket.eventQueue,
  //         entropyAccount.getOpenOrdersKeysInBasket(),
  //         nativeBidPrice,
  //         nativeBidSize,
  //         new BN(Date.now()),
  //         'buy',
  //         'postOnlySlide',
  //       );
  //       tx.add(placeBidInstruction);
  //       const placeAskInstruction = makePlacePerpOrderInstruction(
  //         entropyProgramId,
  //         entropyGroup.publicKey,
  //         entropyAccount.publicKey,
  //         payer.publicKey,
  //         entropyGroup.entropyCache,
  //         perpMarket.publicKey,
  //         perpMarket.bids,
  //         perpMarket.asks,
  //         perpMarket.eventQueue,
  //         entropyAccount.getOpenOrdersKeysInBasket(),
  //         nativeAskPrice,
  //         nativeAskSize,
  //         new BN(Date.now()),
  //         'sell',
  //         'postOnlySlide',
  //       );
  //       tx.add(placeAskInstruction);
  //       // const txid = await client.sendTransaction(tx, payer, []);
  //     }
  //   }
  // }
  const fundingTxid = await client.updateFunding(
    entropyGroup.publicKey,
    entropyGroup.entropyCache,
    perpMarket.publicKey,
    perpMarket.bids,
    perpMarket.asks,
    payer,
  );
  console.log(`fundingTxid: ${fundingTxid.toString()}`);
}
fillBook();
