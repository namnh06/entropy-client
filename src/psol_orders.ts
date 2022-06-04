import * as os from 'os';
import * as fs from 'fs';
import { EntropyClient } from './client';
import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import configFile from './ids.json';
import { Config, getMarketByBaseSymbolAndKind, GroupConfig } from './config';
import { Market } from '@project-serum/serum';
import { ZERO_BN } from './utils';
import EntropyGroup from './EntropyGroup';
import { addSwitchboardOracle, addPerpMarket } from './commands';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(
        os.homedir() + '/.config/solana/entropy-mainnet-authority.json',
        'utf-8',
      ),
  );
}

function readKeypair_opp() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf-8'),
  );
}

async function examplePerp() {
  // setup client
  const config = new Config(configFile);
  const groupConfig = config.getGroup('devnet', 'devnet.2') as GroupConfig;
  const connection = new Connection(
    'https://api.devnet.solana.com',
    'confirmed' as Commitment,
  );
  const client = new EntropyClient(connection, groupConfig.entropyProgramId);
  const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);

  // // load group & market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    'SOL',
    'perp',
  );

  const perpMarket = await entropyGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  // Fetch orderbooks
  const bids = await perpMarket.loadBids(connection);
  const asks = await perpMarket.loadAsks(connection);

  // Place order
  const owner = new Account(readKeypair());
  const asker = new Account(readKeypair_opp());
  const entropyAccount = (
    await client.getEntropyAccountsForOwner(entropyGroup, owner.publicKey)
  )[0];

  const entropyAccount_two = (
    await client.getEntropyAccountsForOwner(entropyGroup, asker.publicKey)
  )[0];

  await client.placePerpOrder(
    entropyGroup,
    entropyAccount,
    entropyGroup.entropyCache,
    perpMarket,
    owner,
    'sell', // or 'sell'
    140,
    0.1,
    'limit',
  ); // or 'ioc' or 'postOnly'

  await client.placePerpOrder(
    entropyGroup,
    entropyAccount_two,
    entropyGroup.entropyCache,
    perpMarket,
    asker,
    'buy', // or 'sell'
    160,
    0.1,
    'limit',
  ); // or 'ioc' or 'postOnly'
}

examplePerp();
