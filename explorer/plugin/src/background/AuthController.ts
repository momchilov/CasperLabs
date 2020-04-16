import { action, computed } from 'mobx';
import passworder from 'browser-passworder';
import store from 'store';
import * as nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { AppState } from '../lib/MemStore';

class AuthController {
  // we store hashed password instead of original password
  private passwordHash: string | null = null;

  // we will use the passwordHash above to encrypt the valut object
  // and then using this key to store it in local storage
  private encryptedVaultKey = 'encryptedVault';

  constructor(private appState: AppState) {
  }

  @action.bound
  async createNewVault(password: string): Promise<void> {
    if (this.getEncryptedVault()) {
      throw new Error('There is a vault already');
    }
    const hash = this.hash(password);
    this.passwordHash = hash;
    await this.clearAccount();
    await this.persistVault(this.passwordHash!);
    this.appState.hasCreatedVault = true;
    this.appState.isUnlocked = true;
  }

  @action
  switchToAccount(accountName: string) {
    let i = this.appState.userAccounts.findIndex(a => a.name === accountName);
    if (i === -1) {
      throw new Error(
        "Couldn't switch to this account because it doesn't exist"
      );
    }
    this.appState.selectedUserAccount = this.appState.userAccounts[i];
  }

  @action
  async importUserAccount(name: string, privateKeyBase64: string) {
    if (!this.appState.isUnlocked) {
      throw new Error('Unlock it before adding new account');
    }

    let account = this.appState.userAccounts.find(account => {
      return (
        account.name === name ||
        encodeBase64(account.signKeyPair.secretKey) === privateKeyBase64
      );
    });

    if (account) {
      throw new Error(
        `A account with same ${
          account.name === name ? 'name' : 'private key'
        } already exists`
      );
    }

    const keyPair = nacl.sign.keyPair.fromSecretKey(
      decodeBase64(privateKeyBase64)
    );

    this.appState.userAccounts.push({
      name: name,
      signKeyPair: keyPair
    });
    this.appState.selectedUserAccount = this.appState.userAccounts[
      this.appState.userAccounts.length - 1
    ];
    this.persistVault(this.passwordHash!);
  }

  /**
   *
   * @param passwordHash hashed password
   */
  private async persistVault(passwordHash: string) {
    const encryptedVault = await passworder.encrypt(
      passwordHash,
      this.appState.userAccounts
    );
    this.saveEncryptedVault(encryptedVault);
  }

  private getEncryptedVault() {
    return store.get(this.encryptedVaultKey);
  }

  private saveEncryptedVault(encryptedVault: string) {
    store.set(this.encryptedVaultKey, encryptedVault);
  }

  private async restoreVault(password: string) {
    let encryptedVault = this.getEncryptedVault();
    if (!encryptedVault) {
      throw new Error('There is no vault');
    }
    const vault = await passworder.decrypt(password, this.encryptedVaultStr);
    return vault as unknown as SignKeyPairWithAlias[];
  }

  /**
   * Hash the user input password for storing locally
   * @param str
   */
  private hash(str: string) {
    const b = new Buffer(str);
    const h = nacl.hash(Uint8Array.from(b));
    return encodeBase64(h);
  }

  /*
   * user can lock the plugin manually, and then user need to use
   * password to unlock, so that the plugin won't be used by others
   */
  @action.bound
  async lock() {
    this.passwordHash = null;
    this.appState.isUnlocked = false;
    await this.clearAccount();
  }

  /**
   * Using the password to unlock
   * @param {string} password
   */
  @action.bound
  async unlock(password: string) {
    const vault = await this.restoreVault(this.hash(password));
    this.appState.isUnlocked = true;
    this.appState.userAccounts.replace(vault);
  }

  @computed
  get isUnlocked(): boolean {
    return this.appState.isUnlocked;
  }

  @action.bound
  async clearAccount() {
    this.appState.userAccounts.clear();
  }
}

export default AuthController;
