// import * as os from 'os';
// import * as fs from 'fs';
// import { EntropyClient } from './client';
// import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
// import configFile from './ids.json';
// import { Config, getMarketByBaseSymbolAndKind, GroupConfig } from './config';
// import { Market } from '@project-serum/serum';
// import { ZERO_BN } from './utils';
// import EntropyGroup from './EntropyGroup';
// import { addSwitchboardOracle, addPerpMarket } from './commands';
// import { awaitTransactionSignatureConfirmation } from '.';

// function readKeypair() {
//   return JSON.parse(
//     process.env.KEYPAIR ||
//       fs.readFileSync(os.homedir() + '/.config/solana/entropy-mainnet-authority.json', 'utf-8'),
//   );
// }

// function readKeypair_opp() {
//   return JSON.parse(
//     process.env.KEYPAIR ||
//       fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf-8'),
//   );
// }

// function writeConfig(configPath: string, config: Config) {
//   fs.writeFileSync(configPath, JSON.stringify(config.toJson(), null, 2));
// }

// async function examplePerp() {
//   // setup client
//   const config = new Config(configFile);
//   const groupConfig = config.getGroup(
//     'devnet',
//     'devnet.2',
//   ) as GroupConfig;
//   const connection = new Connection(
//     'https://api.devnet.solana.com',
//     'confirmed' as Commitment,
//   );
//   const client = new EntropyClient(connection, groupConfig.entropyProgramId);
//   const entropyGroup = await client.getEntropyGroup(groupConfig.publicKey);
//   const owner = new Account(readKeypair());

//   const oracle = new PublicKey(
//     // "4AGPMUEfBCSNqVd4Y6veHAep6VPtrkMa89rBhPqMYegz" // BTCI7V
//     "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix" // SOL oracle devnet
//     );

//   console.log("ADDING PERP MARKET...");
//   client.addPerpMarket(entropyGroup,
//       oracle,
//       new PublicKey("Bb9bsTQa1bGEtQ5KagGkvSHyuLqDWumFUcRqFusFNJWC"),
//       owner,
//       10,
//       10,
//       0.05,
//       0.05,
//       0,
//       0.01,
//       0.01,
//       10,
//       25,
//       0.05,
//       5,
//       0,
//       0);
// }

// async function retrievePerp() {
//   // load group & market
//   const perpMarketConfig = getMarketByBaseSymbolAndKind(
//     groupConfig,
//     'SOL',
//     'perp',
//   );
//   console.log("CONFIG: ",perpMarketConfig.bidsKey.toString());
//   const perpMarket = await entropyGroup.loadPerpMarket(
//   connection,
//   perpMarketConfig.marketIndex,
//   perpMarketConfig.baseDecimals,
//   perpMarketConfig.quoteDecimals,
//   );
//   console.log(perpMarket.toPrettyString(entropyGroup, perpMarketConfig));

// }

// examplePerp();
