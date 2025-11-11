// verification.test.ts
// Mock tests for verification.clar using TypeScript and Vitest
// Well-typed interfaces, stateful mock class simulating contract behavior
// Tests cover core flows: initiation, evidence, disputes, consensus, revocation

import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface VerificationState {
  verified: boolean;
  rating: number;
  timestamp: number;
  verifier: string;
  evidenceHash?: Buffer | null;
  disputeActive: boolean;
  disputeEvidence: Buffer[];
  consensusCount: number;
  totalParties: number;
  oracleCalled: boolean;
  revocationReason?: string | null;
}

interface DisputeState {
  initiatedAt: number;
  timeoutBlock: number;
  oracleResponse?: boolean | null;
  resolutionTimestamp?: number | null;
  feePaid: number;
}

interface EvidenceLog {
  hash: Buffer;
  submitter: string;
  timestamp: number;
  description: string;
  verified: boolean;
}

interface ContractState {
  verifications: Map<number, VerificationState>;
  disputes: Map<number, DisputeState>;
  evidenceLog: Map<string, EvidenceLog>; // Key: `${bookingId}-${submissionId}`
  nextSubmissionId: number;
  admin: string;
}

// Mock contract implementation
class VerificationMock {
  private state: ContractState = {
    verifications: new Map(),
    disputes: new Map(),
    evidenceLog: new Map(),
    nextSubmissionId: 1,
    admin: "deployer",
  };

  private blockHeight: number = 1;

  private ERR_NOT_PARTY = 600;
  private ERR_ALREADY_VERIFIED = 601;
  private ERR_INVALID_RATING = 602;
  private ERR_DISPUTE_IN_PROGRESS = 603;
  private ERR_EVIDENCE_TOO_LARGE = 604;
  private ERR_NO_ESCROW = 605;
  private ERR_ORACLE_NOT_CALLED = 606;
  private ERR_CONSENSUS_NOT_REACHED = 607;
  private ERR_REVOCATION_NOT_ALLOWED = 608;
  private ERR_INVALID_EVIDENCE_HASH = 609;

  private mockBooking = {
    getBooking: (id: number): ClarityResponse<any> => {
      // Mock booking data
      return {
        ok: true,
        value: {
          provider: "provider",
          requester: "requester",
          hours: 10,
          escrowed: true,
        },
      };
    },
  };

  private mockUserProfile = {
    updateRating: (user: string, rating: number): ClarityResponse<boolean> => {
      // Mock success
      return { ok: true, value: true };
    },
  };

  private mockCareHourToken = {
    transfer: (amount: number, from: string, to: string): ClarityResponse<boolean> => {
      // Mock success
      return { ok: true, value: true };
    },
  };

  getVerificationState(bookingId: number): ClarityResponse<VerificationState | null> {
    const state = this.state.verifications.get(bookingId);
    return { ok: true, value: state ?? null };
  }

  getDisputeState(bookingId: number): ClarityResponse<DisputeState | null> {
    const state = this.state.disputes.get(bookingId);
    return { ok: true, value: state ?? null };
  }

  getEvidence(bookingId: number, submissionId: number): ClarityResponse<EvidenceLog | null> {
    const key = `${bookingId}-${submissionId}`;
    const evidence = this.state.evidenceLog.get(key);
    return { ok: true, value: evidence ?? null };
  }

  setBlockHeight(height: number) {
    this.blockHeight = height;
  }

  // Simulate initiate-verification
  initiateVerification(
    caller: string,
    bookingId: number,
    satisfied: boolean,
    rating?: number,
    evidenceHash?: Buffer | null
  ): ClarityResponse<any> {
    if (!this.isParty(bookingId, caller)) {
      return { ok: false, value: this.ERR_NOT_PARTY };
    }
    if (this.state.verifications.has(bookingId)) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }
    if (rating !== undefined && (rating < 0 || rating > 100)) {
      return { ok: false, value: this.ERR_INVALID_RATING };
    }
    if (evidenceHash && !Buffer.isBuffer(evidenceHash)) {
      return { ok: false, value: this.ERR_INVALID_EVIDENCE_HASH };
    }

    const verifState: VerificationState = {
      verified: satisfied,
      rating: rating ?? 0,
      timestamp: this.blockHeight,
      verifier: caller,
      evidenceHash,
      disputeActive: !satisfied,
      disputeEvidence: [],
      consensusCount: 1,
      totalParties: 2,
      oracleCalled: false,
      revocationReason: null,
    };

    this.state.verifications.set(bookingId, verifState);

    if (evidenceHash) {
      const subId = this.state.nextSubmissionId++;
      this.state.evidenceLog.set(`${bookingId}-${subId}`, {
        hash: evidenceHash,
        submitter: caller,
        timestamp: this.blockHeight,
        description: satisfied ? "Service completed" : "Service disputed",
        verified: satisfied,
      });
    }

    if (satisfied) {
      this.releaseEscrow(bookingId, caller);
      this.updateReputations(bookingId, rating ?? 0);
      return { ok: true, value: { state: verifState, action: "released" } };
    } else {
      return { ok: true, value: { state: verifState, action: "pending-dispute" } };
    }
  }

  private isParty(bookingId: number, caller: string): boolean {
    // Mock: Assume caller is party if provider or requester
    return caller === "provider" || caller === "requester";
  }

  private releaseEscrow(bookingId: number, verifier: string): ClarityResponse<boolean> {
    // Mock transfer success
    this.mockCareHourToken.transfer(10, "contract", "provider");
    return { ok: true, value: true };
  }

  private updateReputations(bookingId: number, rating: number): ClarityResponse<boolean> {
    // Mock updates
    this.mockUserProfile.updateRating("requester", rating);
    this.mockUserProfile.updateRating("provider", 100 - rating);
    return { ok: true, value: true };
  }

  // Simulate submit-evidence
  submitEvidence(
    caller: string,
    bookingId: number,
    evidenceHash: Buffer,
    description: string
  ): ClarityResponse<any> {
    if (!this.isParty(bookingId, caller)) {
      return { ok: false, value: this.ERR_NOT_PARTY };
    }
    const verif = this.state.verifications.get(bookingId);
    if (!verif) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }

    const subId = this.state.nextSubmissionId++;
    this.state.evidenceLog.set(`${bookingId}-${subId}`, {
      hash: evidenceHash,
      submitter: caller,
      timestamp: this.blockHeight,
      description,
      verified: false,
    });

    let updatedVerif = { ...verif };
    if (verif.disputeActive) {
      if (updatedVerif.disputeEvidence.length >= 5) {
        return { ok: false, value: this.ERR_EVIDENCE_TOO_LARGE };
      }
      updatedVerif.disputeEvidence.push(evidenceHash);
    } else {
      updatedVerif.evidenceHash = evidenceHash;
    }
    this.state.verifications.set(bookingId, updatedVerif);

    return {
      ok: true,
      value: verif.disputeActive
        ? { action: "evidence-added-to-dispute", subId }
        : { action: "evidence-updated", subId },
    };
  }

  // Simulate initiate-dispute
  initiateDispute(caller: string, bookingId: number, fee: number): ClarityResponse<any> {
    if (!this.isParty(bookingId, caller)) {
      return { ok: false, value: this.ERR_NOT_PARTY };
    }
    const verif = this.state.verifications.get(bookingId);
    if (!verif?.disputeActive) {
      return { ok: false, value: this.ERR_DISPUTE_IN_PROGRESS };
    }
    if (fee <= 0) {
      return { ok: false, value: this.ERR_INVALID_RATING };
    }

    // Mock fee transfer
    this.mockCareHourToken.transfer(fee, caller, this.state.admin);

    this.state.disputes.set(bookingId, {
      initiatedAt: this.blockHeight,
      timeoutBlock: this.blockHeight + 144,
      oracleResponse: null,
      resolutionTimestamp: null,
      feePaid: fee,
    });

    return { ok: true, value: { disputeId: bookingId, timeout: this.blockHeight + 144 } };
  }

  // Simulate confirm-consensus
  confirmConsensus(caller: string, bookingId: number, agrees: boolean): ClarityResponse<any> {
    if (!this.isParty(bookingId, caller)) {
      return { ok: false, value: this.ERR_NOT_PARTY };
    }
    const verif = this.state.verifications.get(bookingId);
    if (!verif) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }
    if (verif.consensusCount >= verif.totalParties) {
      return { ok: false, value: this.ERR_CONSENSUS_NOT_REACHED };
    }

    if (caller === verif.verifier) {
      return { ok: true, value: { status: "consensus-pending", count: verif.consensusCount } };
    }

    const newCount = verif.consensusCount + 1;
    let updatedVerif = { ...verif, consensusCount: newCount };
    this.state.verifications.set(bookingId, updatedVerif);

    if (newCount === verif.totalParties) {
      updatedVerif.verified = agrees;
      this.state.verifications.set(bookingId, updatedVerif);
      if (agrees) {
        this.releaseEscrow(bookingId, caller);
        this.updateReputations(bookingId, verif.rating);
        return { ok: true, value: { status: "consensus-reached", finalized: true } };
      } else {
        this.initiateDispute(caller, bookingId, 10);
        return { ok: true, value: { status: "consensus-dispute", finalized: false } };
      }
    }
    return { ok: true, value: { status: "consensus-pending", count: newCount } };
  }

  // Simulate revoke-verification
  revokeVerification(caller: string, bookingId: number, reason: string): ClarityResponse<any> {
    if (caller !== this.state.admin && !this.isParty(bookingId, caller)) {
      return { ok: false, value: this.ERR_NOT_PARTY };
    }
    const verif = this.state.verifications.get(bookingId);
    if (!verif) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }
    const age = this.blockHeight - verif.timestamp;
    if (age > 10) {
      return { ok: false, value: this.ERR_REVOCATION_NOT_ALLOWED };
    }

    verif.verified = false;
    verif.disputeActive = true;
    verif.revocationReason = reason;
    this.state.verifications.set(bookingId, verif);

    return { ok: true, value: { action: "revoked", reason } };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  provider: "provider",
  requester: "requester",
  admin: "admin",
};

describe("Verification Contract", () => {
  let contract: VerificationMock;

  beforeEach(() => {
    contract = new VerificationMock();
    vi.resetAllMocks();
  });

  it("should initiate verification successfully for satisfied service", () => {
    const result = contract.initiateVerification(
      accounts.provider,
      1,
      true,
      90,
      Buffer.from("evidence-hash")
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(
      expect.objectContaining({
        action: "released",
        state: expect.objectContaining({
          verified: true,
          rating: 90,
          disputeActive: false,
          consensusCount: 1,
        }),
      })
    );
    const state = contract.getVerificationState(1);
    expect(state.ok).toBe(true);
    expect(state.value?.verified).toBe(true);
  });

  it("should reject initiation by non-party", () => {
    const result = contract.initiateVerification("stranger", 1, true, 90);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(600);
  });

  it("should initiate dispute-pending verification", () => {
    const result = contract.initiateVerification(accounts.requester, 1, false, 20);
    expect(result.ok).toBe(true);
    expect(result.value.action).toBe("pending-dispute");
    const state = contract.getVerificationState(1);
    expect(state.value?.disputeActive).toBe(true);
  });

  it("should submit evidence and add to dispute", () => {
    // First initiate dispute-pending
    contract.initiateVerification(accounts.provider, 1, false, 20);

    const evidence = Buffer.from("dispute-evidence");
    const result = contract.submitEvidence(accounts.requester, 1, evidence, "Poor service");
    expect(result.ok).toBe(true);
    expect(result.value.action).toBe("evidence-added-to-dispute");

    const ev = contract.getEvidence(1, 1);
    expect(ev.ok).toBe(true);
    expect(ev.value?.hash).toEqual(evidence);
  });

  it("should initiate dispute with fee", () => {
    contract.initiateVerification(accounts.provider, 1, false, 20);

    const result = contract.initiateDispute(accounts.requester, 1, 5);
    expect(result.ok).toBe(true);
    expect(result.value.timeout).toBe(145);

    const dispute = contract.getDisputeState(1);
    expect(dispute.ok).toBe(true);
    expect(dispute.value?.feePaid).toBe(5);
  });

  it("should reach consensus and release", () => {
    contract.initiateVerification(accounts.provider, 1, true, 80);

    const result1 = contract.confirmConsensus(accounts.provider, 1, true);
    expect(result1.ok).toBe(true);
    expect(result1.value.status).toBe("consensus-pending");

    // Requester confirms
    const result2 = contract.confirmConsensus(accounts.requester, 1, true);
    expect(result2.ok).toBe(true);
    expect(result2.value.status).toBe("consensus-reached");

    const state = contract.getVerificationState(1);
    expect(state.value?.verified).toBe(true);
  });

  it("should revoke verification within grace period", () => {
    contract.initiateVerification(accounts.provider, 1, true, 90);

    const result = contract.revokeVerification(accounts.deployer, 1, "Fraud detected");
    expect(result.ok).toBe(true);
    expect(result.value.action).toBe("revoked");

    const state = contract.getVerificationState(1);
    expect(state.value?.verified).toBe(false);
    expect(state.value?.revocationReason).toBe("Fraud detected");
  });

  it("should reject revocation after grace period", () => {
    contract.initiateVerification(accounts.provider, 1, true, 90);
    contract.setBlockHeight(12);

    const result = contract.revokeVerification(accounts.provider, 1, "Late revoke");
    expect(result.ok).toBe(false);
  });
});