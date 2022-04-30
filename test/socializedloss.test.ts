import fs from 'fs';
import os from 'os';
import {
  Cluster,
  Config,
  EntropyClient,
  MAX_PAIRS,
  sleep,
  throwUndefined,
  MAX_NUM_IN_MARGIN_BASKET,
  QUOTE_INDEX,
  I80F48,
} from '../src';
import configFile from '../src/ids.json';
import { Account, Commitment, Connection } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

async function testSocializedLoss() {
  // Load all the details for entropy group
  const groupName = process.env.GROUP || 'devnet.3';
  const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
  const sleepTime = 500;
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
        fs.readFileSync(os.homedir() + '/.config/solana/entropy-mainnet-authority.json', 'utf-8'),
    ),
  );
  const connection = new Connection(
    config.cluster_urls[cluster],
    'processed' as Commitment,
  );

  const client = new EntropyClient(connection, entropyProgramId);
  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);
  let rootBanks = await entropyGroup.loadRootBanks(connection);
  const quoteRootBank = rootBanks[QUOTE_INDEX];
  if (!quoteRootBank) {
    throw new Error();
  }
  const quoteNodeBanks = await quoteRootBank.loadNodeBanks(connection);

    const liqor = await client.initEntropyAccount(entropyGroup, payer);
    console.log('Created Liqor:', liqor.toBase58());
    await sleep(sleepTime);
    const liqorAccount = await client.getEntropyAccount(
      liqor,
      entropyGroup.dexProgramId,
    );
    const tokenConfig = groupIds.tokens[QUOTE_INDEX];
    const tokenInfo = entropyGroup.tokens[QUOTE_INDEX];
    const token = new Token(
      connection,
      tokenInfo.mint,
      TOKEN_PROGRAM_ID,
      payer,
    );
    const wallet = await token.getOrCreateAssociatedAccountInfo(
      payer.publicKey,
    );

    await client.deposit(
      entropyGroup,
      liqorAccount,
      payer,
      quoteRootBank.publicKey,
      quoteNodeBanks[0].publicKey,
      quoteNodeBanks[0].vault,
      wallet.address,
      1000,
    );


    await liqorAccount.reload(connection);
    console.log('LIQOR', liqorAccount.publicKey.toBase58());

    const entropyAccountPk = await client.initEntropyAccount(entropyGroup, payer);
    await sleep(sleepTime);
    let entropyAccount = await client.getEntropyAccount(
      entropyAccountPk,
      entropyGroup.dexProgramId,
    );
    console.log('Created Liqee:', entropyAccountPk.toBase58());

    const cache = await entropyGroup.loadCache(connection);
    // deposit
    await sleep(sleepTime / 2);

      const rayTokenConfig = groupIds.tokens[6];
      const tokenIndex = entropyGroup.getTokenIndex(rayTokenConfig.mintKey);
      const rootBank = throwUndefined(rootBanks[tokenIndex]);
    const rayTokenInfo = entropyGroup.tokens[tokenIndex];
    console.log(rayTokenConfig.symbol)
      const rayToken = new Token(
        connection,
        rayTokenInfo.mint,
        TOKEN_PROGRAM_ID,
        payer,
      );
      const rayWallet = await rayToken.getOrCreateAssociatedAccountInfo(
        payer.publicKey,
      );

      await sleep(sleepTime / 2);
      const banks = await rootBank.loadNodeBanks(connection);

      await sleep(sleepTime);

    console.log('Resetting oracle');
      await client.setStubOracle(
        entropyGroupKey,
        entropyGroup.oracles[5],
        payer,
        10,
      );
      console.log('Depositing');
        await client.deposit(
          entropyGroup,
          entropyAccount,
          payer,
          rootBank.publicKey,
          banks[0].publicKey,
          banks[0].vault,
          rayWallet.address,
          10,
        );
        await sleep(1000);
    await entropyAccount.reload(connection, entropyGroup.dexProgramId);
    console.log('Liqee Value', entropyAccount.getAssetsVal(entropyGroup, cache, 'Init').toString());
    console.log(entropyAccount.toPrettyString(groupIds, entropyGroup, cache));
    console.log('withdrawing');
    await client.withdraw(
      entropyGroup,
      entropyAccount,
      payer,
      quoteRootBank.publicKey,
      quoteRootBank.nodeBanks[0],
      quoteNodeBanks[0].vault,
      10,
      true,
    );

    await entropyAccount.reload(connection);
    console.log('Liqee Health:', entropyAccount.getHealth(entropyGroup, cache, 'Maint').toString());
    console.log('LIQEE', entropyAccount.publicKey.toBase58());

    await client.setStubOracle(
        entropyGroupKey,
        entropyGroup.oracles[5],
        payer,
        0.5,
    );

    rootBanks = await entropyGroup.loadRootBanks(connection);
    let assetRootBank = rootBanks[5];
    let liabRootBank = rootBanks[QUOTE_INDEX];
    if (!liabRootBank || !assetRootBank) {
        throw new Error('Root Banks not found');
    }
    const liabAmount = entropyAccount.getNativeBorrow(liabRootBank, QUOTE_INDEX);

    await sleep(1000);

    rootBanks = await entropyGroup.loadRootBanks(connection);
    assetRootBank = rootBanks[5];
    liabRootBank = rootBanks[QUOTE_INDEX];
    if (!liabRootBank || !assetRootBank) {
        throw new Error('Root Banks not found');
    }

    const preLiqQuoteDeposits = quoteRootBank.getNativeTotalDeposit();
    console.log('PreLiq', preLiqQuoteDeposits.toString());

    console.log('Liquidating');
    await client.liquidateTokenAndToken(entropyGroup, entropyAccount, liqorAccount, assetRootBank, liabRootBank, payer, I80F48.fromNumber(Math.abs(liabAmount.toNumber())));
    await entropyAccount.reload(connection, entropyGroup.dexProgramId);
    await sleep(1000);

    rootBanks = await entropyGroup.loadRootBanks(connection);
    assetRootBank = rootBanks[5];
    liabRootBank = rootBanks[QUOTE_INDEX];
    if (!liabRootBank || !assetRootBank) {
        throw new Error('Root Banks not found');
    }

    const preLossQuoteDeposits = liabRootBank.getNativeTotalDeposit();
    console.log('Pre', preLossQuoteDeposits.toString());

    if (entropyAccount.isBankrupt) {
        console.log('resolveTokenBankruptcy');
        await client.resolveTokenBankruptcy(entropyGroup, entropyAccount, liqorAccount, quoteRootBank, liabRootBank, payer, I80F48.fromNumber(Math.abs(entropyAccount.getNativeBorrow(liabRootBank, QUOTE_INDEX).toNumber())));
    } else {
        console.log('Account was not bankrupt');
    }
    await sleep(5000);

    rootBanks = await entropyGroup.loadRootBanks(connection);
    assetRootBank = rootBanks[5];
    liabRootBank = rootBanks[QUOTE_INDEX];
    if (!liabRootBank || !assetRootBank) {
        throw new Error('Root Banks not found');
    }

    const postLossQuoteDeposits = liabRootBank.getNativeTotalDeposit();
    console.log('Post', postLossQuoteDeposits.toString());

    console.log('Diff', preLossQuoteDeposits.sub(postLossQuoteDeposits).toString());
}

testSocializedLoss();
