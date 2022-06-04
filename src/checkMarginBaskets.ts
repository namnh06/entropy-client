import { Account, Commitment, Connection } from '@solana/web3.js';
import { EntropyClient } from './client';
import { Cluster, Config } from './config';
import * as os from 'os';
import * as fs from 'fs';

const config = Config.ids();
const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
const connection = new Connection(
  config.cluster_urls[cluster],
  'confirmed' as Commitment,
);

const groupName = process.env.GROUP || 'mainnet.2';
const groupIds = config.getGroup(cluster, groupName);
if (!groupIds) {
  throw new Error(`Group ${groupName} not found`);
}

const entropyProgramId = groupIds.entropyProgramId;
const entropyGroupKey = groupIds.publicKey;
const client = new EntropyClient(connection, entropyProgramId);

const payer = new Account(
  JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(
        os.homedir() + '/.config/solana/entropy-mainnet-authority.json',
        'utf-8',
      ),
  ),
);

async function check() {
  const group = await client.getEntropyGroup(entropyGroupKey);
  const entropyAccounts = await client.getAllEntropyAccounts(
    group,
    undefined,
    true,
  );
  let total = 0;

  for (const entropyAccount of entropyAccounts) {
    const oos = entropyAccount.spotOpenOrdersAccounts;

    const shouldFix = oos.some((oo, i) => {
      if (oo) {
        const freeSlotBitsStr = oo['freeSlotBits'].toString();
        const isEmpty =
          oo.quoteTokenTotal.isZero() &&
          oo.baseTokenTotal.isZero() &&
          oo['referrerRebatesAccrued'].isZero() &&
          freeSlotBitsStr == '340282366920938463463374607431768211455';

        const inBasketAndEmpty = entropyAccount.inMarginBasket[i] && isEmpty;
        const notInBasketAndNotEmpty =
          !entropyAccount.inMarginBasket[i] && !isEmpty;

        if (inBasketAndEmpty || notInBasketAndNotEmpty) {
          console.log(
            entropyAccount.publicKey.toString(),
            entropyAccount.name,
            inBasketAndEmpty,
            notInBasketAndNotEmpty,
            oo.quoteTokenTotal.toString(),
            oo.baseTokenTotal.toString(),
            oo['referrerRebatesAccrued'].toString(),
            freeSlotBitsStr,
          );
        }

        return inBasketAndEmpty || notInBasketAndNotEmpty;
      }
    });
    if (shouldFix) {
      // await client.updateMarginBasket(group, entropyAccount, payer);
      total++;
    }
  }

  console.log('Total', total);
}

check();
