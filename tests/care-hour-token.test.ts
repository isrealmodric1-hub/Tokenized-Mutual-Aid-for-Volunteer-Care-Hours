import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface MintRecord {
  amount: number;
  recipient: string;
  metadata: string;
  timestamp: number;
  minter: string;
}

interface ContractState {
  balances: Map<string, number>;
  minters: Map<string, boolean>;
  mintRecords: Map<number, MintRecord>;
  totalSupply: number;
  paused: boolean;
  admin: string;
  mintCounter: number;
  tokenUri: string | null;
}

// Mock contract implementation
class CareHourTokenMock {
  private state: ContractState = {
    balances: new Map(),
    minters: new Map([["deployer", true]]),
    mintRecords: new Map(),
    totalSupply: 0,
    paused: false,
    admin: "deployer",
    mintCounter: 0,
    tokenUri: null,
  };

  private MAX_SUPPLY = 1000000000;
  private MAX_METADATA_LEN = 500;
  private ERR_NOT_AUTHORIZED = 100;
  private ERR_PAUSED = 101;
  private ERR_INVALID_AMOUNT = 102;
  private ERR_INVALID_RECIPIENT = 103;
  private ERR_INVALID_MINTER = 104;
  private ERR_ALREADY_REGISTERED = 105;
  private ERR_METADATA_TOO_LONG = 106;
  private ERR_SUPPLY_EXCEEDED = 107;
  private ERR_INSUFFICIENT_BALANCE = 108;
  private ERR_INVALID_PRINCIPAL = 109;
  private ERR_NOT_OWNER = 110;
  private ERR_ALREADY_PAUSED = 111;
  private ERR_NOT_PAUSED = 112;

  getName(): ClarityResponse<string> {
    return { ok: true, value: "CareHour" };
  }

  getSymbol(): ClarityResponse<string> {
    return { ok: true, value: "CH" };
  }

  getDecimals(): ClarityResponse<number> {
    return { ok: true, value: 0 };
  }

  getTotalSupply(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalSupply };
  }

  getBalance(account: string): ClarityResponse<number> {
    return { ok: true, value: this.state.balances.get(account) ?? 0 };
  }

  getTokenUri(): ClarityResponse<string | null> {
    return { ok: true, value: this.state.tokenUri };
  }

  getMintRecord(recordId: number): ClarityResponse<MintRecord | null> {
    return { ok: true, value: this.state.mintRecords.get(recordId) ?? null };
  }

  isMinter(account: string): ClarityResponse<boolean> {
    return { ok: true, value: this.state.minters.get(account) ?? false };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  getMintCounter(): ClarityResponse<number> {
    return { ok: true, value: this.state.mintCounter };
  }

  transfer(caller: string, amount: number, sender: string, recipient: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (caller !== sender) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (recipient === "invalid") { // Placeholder for invalid recipient
      return { ok: false, value: this.ERR_INVALID_RECIPIENT };
    }
    const senderBalance = this.state.balances.get(sender) ?? 0;
    if (senderBalance < amount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    this.state.balances.set(sender, senderBalance - amount);
    const recipientBalance = this.state.balances.get(recipient) ?? 0;
    this.state.balances.set(recipient, recipientBalance + amount);
    return { ok: true, value: true };
  }

  mint(caller: string, amount: number, recipient: string, metadata: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (!this.state.minters.get(caller)) {
      return { ok: false, value: this.ERR_INVALID_MINTER };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (recipient === "deployer") {
      return { ok: false, value: this.ERR_INVALID_RECIPIENT };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_METADATA_TOO_LONG };
    }
    if (this.state.totalSupply + amount > this.MAX_SUPPLY) {
      return { ok: false, value: this.ERR_SUPPLY_EXCEEDED };
    }
    const currentBalance = this.state.balances.get(recipient) ?? 0;
    this.state.balances.set(recipient, currentBalance + amount);
    this.state.totalSupply += amount;
    const recordId = this.state.mintCounter + 1;
    this.state.mintRecords.set(recordId, {
      amount,
      recipient,
      metadata,
      timestamp: Date.now(),
      minter: caller,
    });
    this.state.mintCounter = recordId;
    return { ok: true, value: true };
  }

  burn(caller: string, amount: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const senderBalance = this.state.balances.get(caller) ?? 0;
    if (senderBalance < amount) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    this.state.balances.set(caller, senderBalance - amount);
    this.state.totalSupply -= amount;
    return { ok: true, value: true };
  }

  addMinter(caller: string, newMinter: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (this.state.minters.get(newMinter)) {
      return { ok: false, value: this.ERR_ALREADY_REGISTERED };
    }
    this.state.minters.set(newMinter, true);
    return { ok: true, value: true };
  }

  removeMinter(caller: string, minter: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.minters.set(minter, false);
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (newAdmin === caller) {
      return { ok: false, value: this.ERR_INVALID_PRINCIPAL };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (this.state.paused) {
      return { ok: false, value: this.ERR_ALREADY_PAUSED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (!this.state.paused) {
      return { ok: false, value: this.ERR_NOT_PAUSED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  setTokenUri(caller: string, newUri: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.tokenUri = newUri;
    return { ok: true, value: true };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  minter: "wallet_1",
  user1: "wallet_2",
  user2: "wallet_3",
};

describe("CareHourToken Contract", () => {
  let contract: CareHourTokenMock;

  beforeEach(() => {
    contract = new CareHourTokenMock();
    vi.resetAllMocks();
  });

  it("should initialize with correct token metadata", () => {
    expect(contract.getName()).toEqual({ ok: true, value: "CareHour" });
    expect(contract.getSymbol()).toEqual({ ok: true, value: "CH" });
    expect(contract.getDecimals()).toEqual({ ok: true, value: 0 });
    expect(contract.getTotalSupply()).toEqual({ ok: true, value: 0 });
    expect(contract.getTokenUri()).toEqual({ ok: true, value: null });
  });

  it("should allow admin to add minter", () => {
    const addMinter = contract.addMinter(accounts.deployer, accounts.minter);
    expect(addMinter).toEqual({ ok: true, value: true });

    const isMinter = contract.isMinter(accounts.minter);
    expect(isMinter).toEqual({ ok: true, value: true });
  });

  it("should prevent non-admin from adding minter", () => {
    const addMinter = contract.addMinter(accounts.user1, accounts.user2);
    expect(addMinter).toEqual({ ok: false, value: 100 });
  });

  it("should allow minter to mint tokens with metadata", () => {
    contract.addMinter(accounts.deployer, accounts.minter);

    const mintResult = contract.mint(
      accounts.minter,
      1000,
      accounts.user1,
      "Volunteered for community care"
    );
    expect(mintResult).toEqual({ ok: true, value: true });
    expect(contract.getBalance(accounts.user1)).toEqual({ ok: true, value: 1000 });
    expect(contract.getTotalSupply()).toEqual({ ok: true, value: 1000 });

    const mintRecord = contract.getMintRecord(1);
    expect(mintRecord).toEqual({
      ok: true,
      value: expect.objectContaining({
        amount: 1000,
        recipient: accounts.user1,
        metadata: "Volunteered for community care",
        minter: accounts.minter,
      }),
    });
  });

  it("should prevent non-minter from minting", () => {
    const mintResult = contract.mint(
      accounts.user1,
      1000,
      accounts.user1,
      "Unauthorized mint"
    );
    expect(mintResult).toEqual({ ok: false, value: 104 });
  });

  it("should prevent minting beyond max supply", () => {
    contract.addMinter(accounts.deployer, accounts.minter);
    // Simulate near max
    contract.mint(accounts.minter, 1000000000 - 100, accounts.user1, "Large mint");

    const overflowMint = contract.mint(accounts.minter, 101, accounts.user1, "Overflow");
    expect(overflowMint).toEqual({ ok: false, value: 107 });
  });

  it("should allow token transfer between users", () => {
    contract.addMinter(accounts.deployer, accounts.minter);
    contract.mint(accounts.minter, 1000, accounts.user1, "Test mint");

    const transferResult = contract.transfer(
      accounts.user1,
      500,
      accounts.user1,
      accounts.user2
    );
    expect(transferResult).toEqual({ ok: true, value: true });
    expect(contract.getBalance(accounts.user1)).toEqual({ ok: true, value: 500 });
    expect(contract.getBalance(accounts.user2)).toEqual({ ok: true, value: 500 });
  });

  it("should prevent transfer of insufficient balance", () => {
    contract.addMinter(accounts.deployer, accounts.minter);
    contract.mint(accounts.minter, 100, accounts.user1, "Test mint");

    const transferResult = contract.transfer(
      accounts.user1,
      200,
      accounts.user1,
      accounts.user2
    );
    expect(transferResult).toEqual({ ok: false, value: 108 });
  });

  it("should allow burning tokens", () => {
    contract.addMinter(accounts.deployer, accounts.minter);
    contract.mint(accounts.minter, 1000, accounts.user1, "Test mint");

    const burnResult = contract.burn(accounts.user1, 300);
    expect(burnResult).toEqual({ ok: true, value: true });
    expect(contract.getBalance(accounts.user1)).toEqual({ ok: true, value: 700 });
    expect(contract.getTotalSupply()).toEqual({ ok: true, value: 700 });
  });

  it("should pause and unpause contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });

    const mintDuringPause = contract.mint(
      accounts.deployer,
      1000,
      accounts.user1,
      "Paused mint"
    );
    expect(mintDuringPause).toEqual({ ok: false, value: 101 });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent metadata exceeding max length", () => {
    contract.addMinter(accounts.deployer, accounts.minter);

    const longMetadata = "a".repeat(501);
    const mintResult = contract.mint(
      accounts.minter,
      1000,
      accounts.user1,
      longMetadata
    );
    expect(mintResult).toEqual({ ok: false, value: 106 });
  });

  it("should allow admin to set token URI", () => {
    const setUri = contract.setTokenUri(accounts.deployer, "https://example.com/metadata.json");
    expect(setUri).toEqual({ ok: true, value: true });
    expect(contract.getTokenUri()).toEqual({ ok: true, value: "https://example.com/metadata.json" });
  });

  it("should prevent non-admin from setting token URI", () => {
    const setUri = contract.setTokenUri(accounts.user1, "https://example.com/metadata.json");
    expect(setUri).toEqual({ ok: false, value: 100 });
  });

  it("should allow admin to change admin", () => {
    const setAdmin = contract.setAdmin(accounts.deployer, accounts.minter);
    expect(setAdmin).toEqual({ ok: true, value: true });
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.minter });
  });

  it("should prevent setting same admin", () => {
    const setAdmin = contract.setAdmin(accounts.deployer, accounts.deployer);
    expect(setAdmin).toEqual({ ok: false, value: 109 });
  });
});