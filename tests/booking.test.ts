import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Booking {
  offerId: number;
  requestId: number;
  provider: string;
  requester: string;
  hours: number;
  escrowedAmount: number;
  status: number;
  startBlock: number | null;
  endBlock: number | null;
  metadata: string;
  disputeBlock: number | null;
}

interface Dispute {
  reason: string;
  initiator: string;
  evidenceHash: string;
}

interface ContractState {
  bookings: Map<number, Booking>;
  disputes: Map<number, Dispute>;
  admin: string;
  paused: boolean;
  nextBookingId: number;
}

// Mock contract implementation
class BookingContractMock {
  private state: ContractState = {
    bookings: new Map(),
    disputes: new Map(),
    admin: "deployer",
    paused: false,
    nextBookingId: 1,
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_OFFER = 300;
  private ERR_INSUFFICIENT_BALANCE = 500;
  private ERR_BOOKING_NOT_FOUND = 502;
  private ERR_INVALID_STATUS = 503;
  private ERR_DISPUTE_ACTIVE = 504;
  private ERR_NO_DISPUTE = 505;
  private ERR_CONTRACT_PAUSED = 506;
  private ERR_INVALID_AMOUNT = 507;
  private ERR_TIMEOUT_NOT_REACHED = 508;
  private ERR_INVALID_METADATA = 509;

  private STATUS_PENDING = 0;
  private STATUS_ACTIVE = 1;
  private STATUS_COMPLETED = 2;
  private STATUS_CANCELLED = 3;
  private STATUS_DISPUTED = 4;
  private STATUS_RESOLVED = 5;

  private MAX_METADATA_LEN = 256;
  private DISPUTE_TIMEOUT = 144;
  private currentBlock = 500;

  // Mocked token balance (for simulation)
  private tokenBalances: Map<string, number> = new Map([["requester", 1000]]);

  // Mock contract-call? simulations
  private mockOffer: { active: boolean; provider: string } = { active: true, provider: "provider" };
  private mockRequest: { active: boolean; requester: string } = { active: true, requester: "requester" };

  bookService(caller: string, offerId: number, requestId: number, hours: number, metadata: string): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    if (!this.mockOffer.active || !this.mockRequest.active) {
      return { ok: false, value: this.ERR_INVALID_OFFER };
    }
    if (caller !== this.mockRequest.requester) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (hours <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA };
    }
    const balance = this.tokenBalances.get(caller) ?? 0;
    if (balance < hours) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    // Simulate escrow
    this.tokenBalances.set(caller, balance - hours);
    const id = this.state.nextBookingId;
    this.state.bookings.set(id, {
      offerId,
      requestId,
      provider: this.mockOffer.provider,
      requester: caller,
      hours,
      escrowedAmount: hours,
      status: this.STATUS_PENDING,
      startBlock: null,
      endBlock: null,
      metadata,
      disputeBlock: null,
    });
    this.state.nextBookingId += 1;
    return { ok: true, value: id };
  }

  startService(caller: string, bookingId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (caller !== booking.provider && caller !== booking.requester) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (booking.status !== this.STATUS_PENDING) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    booking.status = this.STATUS_ACTIVE;
    booking.startBlock = this.currentBlock;
    this.state.bookings.set(bookingId, booking);
    return { ok: true, value: true };
  }

  completeService(caller: string, bookingId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (caller !== booking.provider) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (booking.status !== this.STATUS_ACTIVE) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    booking.status = this.STATUS_COMPLETED;
    booking.endBlock = this.currentBlock;
    // Simulate release
    const providerBalance = this.tokenBalances.get(booking.provider) ?? 0;
    this.tokenBalances.set(booking.provider, providerBalance + booking.escrowedAmount);
    this.state.bookings.set(bookingId, booking);
    return { ok: true, value: true };
  }

  cancelBooking(caller: string, bookingId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (caller !== booking.provider && caller !== booking.requester) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (booking.status !== this.STATUS_PENDING) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    // Simulate refund
    const requesterBalance = this.tokenBalances.get(booking.requester) ?? 0;
    this.tokenBalances.set(booking.requester, requesterBalance + booking.escrowedAmount);
    booking.status = this.STATUS_CANCELLED;
    this.state.bookings.set(bookingId, booking);
    return { ok: true, value: true };
  }

  initiateDispute(caller: string, bookingId: number, reason: string, evidenceHash: string): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (caller !== booking.provider && caller !== booking.requester) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (booking.status !== this.STATUS_ACTIVE && booking.status !== this.STATUS_COMPLETED) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (booking.disputeBlock !== null) {
      return { ok: false, value: this.ERR_DISPUTE_ACTIVE };
    }
    if (reason.length === 0) {
      return { ok: false, value: this.ERR_INVALID_METADATA };
    }
    booking.status = this.STATUS_DISPUTED;
    booking.disputeBlock = this.currentBlock;
    this.state.bookings.set(bookingId, booking);
    this.state.disputes.set(bookingId, { reason, initiator: caller, evidenceHash });
    return { ok: true, value: true };
  }

  resolveDispute(caller: string, bookingId: number, releaseToProvider: boolean): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (booking.status !== this.STATUS_DISPUTED) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (!this.state.disputes.has(bookingId)) {
      return { ok: false, value: this.ERR_NO_DISPUTE };
    }
    // Simulate release
    if (releaseToProvider) {
      const providerBalance = this.tokenBalances.get(booking.provider) ?? 0;
      this.tokenBalances.set(booking.provider, providerBalance + booking.escrowedAmount);
    } else {
      const requesterBalance = this.tokenBalances.get(booking.requester) ?? 0;
      this.tokenBalances.set(booking.requester, requesterBalance + booking.escrowedAmount);
    }
    booking.status = this.STATUS_RESOLVED;
    this.state.bookings.set(bookingId, booking);
    this.state.disputes.delete(bookingId);
    return { ok: true, value: true };
  }

  timeoutRefund(bookingId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const booking = this.state.bookings.get(bookingId);
    if (!booking) {
      return { ok: false, value: this.ERR_BOOKING_NOT_FOUND };
    }
    if (booking.status !== this.STATUS_DISPUTED) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (booking.disputeBlock === null || (this.currentBlock - booking.disputeBlock) < this.DISPUTE_TIMEOUT) {
      return { ok: false, value: this.ERR_TIMEOUT_NOT_REACHED };
    }
    // Simulate refund
    const requesterBalance = this.tokenBalances.get(booking.requester) ?? 0;
    this.tokenBalances.set(booking.requester, requesterBalance + booking.escrowedAmount);
    booking.status = this.STATUS_RESOLVED;
    this.state.bookings.set(bookingId, booking);
    this.state.disputes.delete(bookingId);
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (caller === newAdmin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  getBooking(id: number): ClarityResponse<Booking | null> {
    return { ok: true, value: this.state.bookings.get(id) ?? null };
  }

  getBookingDispute(id: number): ClarityResponse<Dispute | null> {
    return { ok: true, value: this.state.disputes.get(id) ?? null };
  }

  getNextId(): ClarityResponse<number> {
    return { ok: true, value: this.state.nextBookingId };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  provider: "provider",
  requester: "requester",
  user: "user",
};

describe("BookingContract", () => {
  let contract: BookingContractMock;

  beforeEach(() => {
    contract = new BookingContractMock();
    vi.resetAllMocks();
  });

  it("should allow requester to book service", () => {
    const result = contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    expect(result).toEqual({ ok: true, value: 1 });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.escrowedAmount).toBe(10);
    expect((booking.value as Booking)?.status).toBe(0); // PENDING
  });

  it("should prevent booking when paused", () => {
    contract.pauseContract(accounts.deployer);
    const result = contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    expect(result).toEqual({ ok: false, value: 506 });
  });

  it("should allow starting service", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    const result = contract.startService(accounts.provider, 1);
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(1); // ACTIVE
  });

  it("should allow completing service and release funds", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    const result = contract.completeService(accounts.provider, 1);
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(2); // COMPLETED
  });

  it("should allow cancelling pending booking", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    const result = contract.cancelBooking(accounts.requester, 1);
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(3); // CANCELLED
  });

  it("should allow initiating dispute with valid reason", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    const result = contract.initiateDispute(accounts.requester, 1, "Issue with service", "hash");
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(4); // DISPUTED
    const dispute = contract.getBookingDispute(1);
    expect((dispute.value as Dispute)?.reason).toBe("Issue with service");
  });

  it("should prevent initiating dispute with empty reason", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    const result = contract.initiateDispute(accounts.requester, 1, "", "hash");
    expect(result).toEqual({ ok: false, value: 509 });
  });

  it("should allow admin to resolve dispute", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    contract.initiateDispute(accounts.requester, 1, "Issue", "hash");
    const result = contract.resolveDispute(accounts.deployer, 1, true);
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(5); // RESOLVED
  });

  it("should allow timeout refund after dispute timeout", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    contract.initiateDispute(accounts.requester, 1, "Issue", "hash");
    // Simulate block height increase
    contract['currentBlock'] = 500 + contract['DISPUTE_TIMEOUT'];
    const result = contract.timeoutRefund(1);
    expect(result).toEqual({ ok: true, value: true });
    const booking = contract.getBooking(1);
    expect((booking.value as Booking)?.status).toBe(5); // RESOLVED
  });

  it("should prevent timeout refund before dispute timeout", () => {
    contract.bookService(accounts.requester, 1, 1, 10, "metadata");
    contract.startService(accounts.provider, 1);
    contract.initiateDispute(accounts.requester, 1, "Issue", "hash");
    const result = contract.timeoutRefund(1);
    expect(result).toEqual({ ok: false, value: 508 });
  });

  it("should allow setting new admin", () => {
    const result = contract.setAdmin(accounts.deployer, accounts.user);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.user });
  });

  it("should prevent setting same admin", () => {
    const result = contract.setAdmin(accounts.deployer, accounts.deployer);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should pause and unpause contract", () => {
    let result = contract.pauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });

    result = contract.unpauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent invalid metadata length", () => {
    const longMetadata = "a".repeat(257);
    const result = contract.bookService(accounts.requester, 1, 1, 10, longMetadata);
    expect(result).toEqual({ ok: false, value: 509 });
  });
});