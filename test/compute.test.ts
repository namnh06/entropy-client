import fs from 'fs';
import os from 'os';
import { Cluster, Config, EntropyClient, sleep, throwUndefined } from '../src';
import configFile from '../src/ids.json';
import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

async function testMaxCompute() {
  // Load all the details for entropy group
  const groupName = process.env.GROUP || 'entropy_test_v3.nightly';
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const config = new Config(configFile);
  const groupIds = config.getGroup(cluster, groupName);

  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  const entropyProgramId = groupIds.entropyProgramId;
  const entropyGroupKey = groupIds.publicKey;
  const payer = new Account(
    JSON.parse(
      process.env.KEYPAIR ||
        fs.readFileSync(
          os.homedir() + '/.config/solana/entropy-mainnet-authority.json',
          'utf-8',
        ),
    ),
  );
  const connection = new Connection(
    config.cluster_urls[cluster],
    'confirmed' as Commitment,
  );

  const client = new EntropyClient(connection, entropyProgramId);
  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);

  // create a new entropy account
  // TODO make this getOrInitEntropyAccount
  // const entropyAccountPk = await client.initEntropyAccount(entropyGroup, payer);
  // console.log('Created EntropyAccountPk:', entropyAccountPk.toBase58());

  const entropyAccountPk = new PublicKey(
    'Dgwt7kchNmM6jwVsDDU1yracgmJBoGE1Wr5X6pUokJGp',
  );

  let entropyAccount = await client.getEntropyAccount(
    entropyAccountPk,
    entropyGroup.dexProgramId,
  );
  const sleepTime = 500;
  const rootBanks = await entropyGroup.loadRootBanks(connection);

  // deposit
  await sleep(sleepTime / 2);

  for (let i = 0; i < groupIds.tokens.length; i++) {
    if (groupIds.tokens[i].symbol === 'SOL') {
      continue;
    }
    const tokenConfig = groupIds.tokens[i];
    const tokenIndex = entropyGroup.getTokenIndex(tokenConfig.mintKey);
    const rootBank = throwUndefined(rootBanks[tokenIndex]);
    const tokenInfo = entropyGroup.tokens[tokenIndex];
    const token = new Token(
      connection,
      tokenInfo.mint,
      TOKEN_PROGRAM_ID,
      payer,
    );
    const wallet = await token.getOrCreateAssociatedAccountInfo(
      payer.publicKey,
    );

    await sleep(sleepTime / 2);
    const banks = await rootBank.loadNodeBanks(connection);

    await sleep(sleepTime);
    console.log('depositing');
    await client.deposit(
      entropyGroup,
      entropyAccount,
      payer,
      rootBank.publicKey,
      banks[0].publicKey,
      banks[0].vault,
      wallet.address,
      1_000_000, //
    );
  }

  // place an order on 10 different spot markets
  for (let i = 0; i < 10; i++) {
    const market = await Market.load(
      connection,
      entropyGroup.spotMarkets[i].spotMarket,
      {},
      entropyGroup.dexProgramId,
    );
    while (1) {
      await sleep(sleepTime);
      console.log('placing spot order', i);
      try {
        await client.placeSpotOrder(
          entropyGroup,
          entropyAccount,
          entropyGroup.entropyCache,
          market,
          payer,
          'sell',
          10001,
          1,
          'limit',
        );
        await sleep(sleepTime);
        entropyAccount = await client.getEntropyAccount(
          entropyAccountPk,
          entropyGroup.dexProgramId,
        );
        break;
      } catch (e) {
        console.log(e);
        continue;
      }
    }

    // for (const oo of entropyAccount.spotOpenOrders) {
    //   console.log(oo.toBase58());
    // }
  }

  // place an order in 32 different perp markets
  // for (let i = 0; i < groupIds.perpMarkets.length; i++) {
  //   await sleep(sleepTime);
  //   const perpMarket = await client.getPerpMarket(
  //     entropyGroup.perpMarkets[i].perpMarket,
  //     groupIds.perpMarkets[i].baseDecimals,
  //     groupIds.perpMarkets[i].quoteDecimals,
  //   );
  //
  //   console.log('placing perp order', i);
  //   await sleep(sleepTime);
  //   await client.placePerpOrder(
  //     entropyGroup,
  //     entropyAccount,
  //     entropyGroup.entropyCache,
  //     perpMarket,
  //     payer,
  //     'buy',
  //     10000,
  //     1,
  //     'limit',
  //   );
  // }
}

testMaxCompute();
