# CareChain: Tokenized Mutual Aid for Volunteer Care Hours

## Overview

CareChain is a decentralized Web3 platform built on the Stacks blockchain using Clarity smart contracts. It tokenizes volunteer care hours (e.g., elderly care, childcare, tutoring, or community support) into a fungible token called "CareHours" (CH). Users earn CH by providing verified volunteer services and spend them to request care from the community. This creates a mutual aid economy that addresses real-world problems like:

- **Affordability and Access**: Low-income or rural communities often lack affordable care services. CareChain enables peer-to-peer exchanges without intermediaries.
- **Volunteer Incentives**: Tokenization rewards contributors transparently, boosting participation in mutual aid networks.
- **Trust and Verification**: Blockchain ensures immutable records of hours logged, reducing fraud and enabling reputation-based matching.
- **Community Resilience**: During crises (e.g., natural disasters or economic downturns), it facilitates rapid mobilization of care resources.

The system involves **6 core smart contracts** for robustness:
1. **care-hour-token.clar**: Fungible token (SIP-005 compliant) for CareHours.
2. **user-profile.clar**: Manages user registration, profiles, and reputation scores.
3. **service-offer.clar**: Handles listing and managing service offers (what users provide).
4. **service-request.clar**: Manages service requests (what users need).
5. **booking.clar**: Facilitates matching, escrow, and booking of services.
6. **verification.clar**: Verifies service completion, releases escrow, and handles basic disputes.

These contracts are interconnected: Profiles link to offers/requests, bookings use escrow from tokens, and verification settles transactions. The frontend (not included here) could be a React app interacting via Stacks.js.

## Features

- **Tokenized Hours**: Earn and spend CH for care services (1 CH = 1 hour).
- **Profile-Based Matching**: Users with verified profiles can offer/request services filtered by skills, location, and ratings.
- **Escrow Security**: Tokens locked until service completion is verified.
- **Reputation System**: Post-verification ratings update profiles for better matching.
- **Decentralized Governance**: Future extension for DAO voting on platform rules (e.g., token burns for inactivity).
- **Privacy Focus**: Off-chain metadata (e.g., service details) hashed on-chain for verification without exposing sensitive data.

## Architecture

- **Blockchain**: Stacks (Bitcoin L2) for low fees and finality.
- **Contracts**: Written in Clarity for safety (no reentrancy risks).
- **Off-Chain Components**:
  - IPFS for storing service descriptions and proofs (e.g., photos of completed work).
  - Oracle integration (e.g., Chainlink on Stacks) for time-based disputes.
- **Data Flow**:
  1. User registers profile → Mints initial CH (airdrop or via volunteering).
  2. Posts offer/request → Matched via booking.
  3. Service performed → Verified → Tokens transferred.

## Prerequisites

- Stacks CLI (`clarinet`) for development/testing.
- Node.js for frontend (if extending).
- Wallet: Hiro Wallet or Leather for deployment.

## Installation

1. Clone the repo:
   ```
   git clone <repo-url>
   cd carechain
   ```

2. Install dependencies:
   ```
   npm install
   # Or for Clarinet:
   cargo install clarinet
   ```

3. Set up Clarinet project:
   ```
   clarinet new carechain
   # Copy contracts into contracts/ folder
   ```

4. Test contracts:
   ```
   clarinet test
   ```

5. Deploy to testnet:
   ```
   clarinet integrate
   # Use deploy.sh script for mainnet
   ```

## Smart Contracts

Below are the full Clarity contracts. Each is self-contained but imports traits where needed (e.g., `traits` from SIPs). Deploy them in order: token → profile → offer → request → booking → verification.

### 1. care-hour-token.clar (Fungible Token for CareHours)

```clarity
;; care-hour-token.clar
;; SIP-005 Fungible Token for CareHours

(define-constant ERR_NOT_AUTHORIZED (err u100))
(define-constant ERR_SUPPLY_OVERFLOW (err u101))

(define-fungible-token care-hour-token u1000000000) ;; Max supply: 1B hours

(define-public (mint (amount: uint) (recipient: principal))
  (if (is-eq tx-sender (as-contract tx-sender))
    (if (and (<= (+ (ft-get-supply care-hour-token) amount) u1000000000)
             (ft-mint? care-hour-token amount recipient))
      ok
      ERR_SUPPLY_OVERFLOW)
    ERR_NOT_AUTHORIZED))

(define-public (transfer (amount: uint) (sender: principal) (recipient: principal))
  (ft-transfer? care-hour-token amount sender recipient))

;; Admin functions (e.g., for initial airdrop)
(define-private (is-admin) (is-eq tx-sender (var-get admin)))
(define-data-var admin principal tx-sender)
```

### 2. user-profile.clar (User Profiles and Reputation)

```clarity
;; user-profile.clar
;; Manages user registration and reputation

(define-constant ERR_ALREADY_REGISTERED (err u200))
(define-constant ERR_NOT_REGISTERED (err u201))

(define-map profiles principal {skills: (list 10 uint), rating: uint, total-hours: uint, verified: bool})

(define-public (register (skills: (list 10 uint)))
  (let ((sender tx-sender))
    (asserts! (not (map-get? profiles sender)) ERR_ALREADY_REGISTERED)
    (map-set profiles sender {skills: skills, rating: u0, total-hours: u0, verified: false})
    (ok true)))

(define-public (update-rating (user: principal) (new-rating: uint))
  (if (and (>= new-rating u0) (<= new-rating u100))
    (let ((current (unwrap! (map-get? profiles user) ERR_NOT_REGISTERED)))
      (map-set profiles user (merge current {rating: new-rating}))
      (ok true))
    (err u202))) ;; Invalid rating

(define-read-only (get-profile (user: principal))
  (map-get? profiles user))
```

### 3. service-offer.clar (Service Offers)

```clarity
;; service-offer.clar
;; Lists available service offers

(define-constant ERR_INVALID_OFFER (err u300))

(define-map offers uint {provider: principal, description-hash: (string-ascii 34), hours: uint, active: bool})

(define-data-var next-id uint u1)

(define-public (create-offer (description-hash: (string-ascii 34)) (hours: uint))
  (let ((sender tx-sender)
        (id (var-get next-id)))
    (asserts! (> hours u0) ERR_INVALID_OFFER)
    (map-set offers id {provider: sender, description-hash: description-hash, hours: hours, active: true})
    (var-set next-id (+ id u1))
    (ok id)))

(define-public (cancel-offer (id: uint))
  (let ((offer (unwrap! (map-get? offers id) ERR_INVALID_OFFER)))
    (asserts! (is-eq tx-sender (get provider offer)) ERR_NOT_AUTHORIZED)
    (map-set offers id (merge offer {active: false}))
    (ok true)))

(define-read-only (get-offer (id: uint))
  (map-get? offers id))
```

### 4. service-request.clar (Service Requests)

```clarity
;; service-request.clar
;; Manages service requests

(define-constant ERR_INVALID_REQUEST (err u400))

(define-map requests uint {requester: principal, description-hash: (string-ascii 34), hours-needed: uint, active: bool})

(define-data-var next-id uint u1)

(define-public (create-request (description-hash: (string-ascii 34)) (hours-needed: uint))
  (let ((sender tx-sender)
        (id (var-get next-id)))
    (asserts! (> hours-needed u0) ERR_INVALID_REQUEST)
    (map-set requests id {requester: sender, description-hash: description-hash, hours-needed: hours-needed, active: true})
    (var-set next-id (+ id u1))
    (ok id)))

(define-public (cancel-request (id: uint))
  (let ((req (unwrap! (map-get? requests id) ERR_INVALID_REQUEST)))
    (asserts! (is-eq tx-sender (get requester req)) ERR_NOT_AUTHORIZED)
    (map-set requests id (merge req {active: false}))
    (ok true)))

(define-read-only (get-request (id: uint))
  (map-get? requests id))
```

### 5. booking.clar (Booking and Escrow)

```clarity
;; booking.clar
;; Matches offers/requests and escrows tokens

(define-constant ERR_INSUFFICIENT_BALANCE (err u500))
(define-constant ERR_ALREADY_BOOKED (err u501))

(define-map bookings uint {offer-id: uint, request-id: uint, provider: principal, requester: principal, hours: uint, escrowed: bool})

(define-data-var next-id uint u1)

(define-public (book-service (offer-id: uint) (request-id: uint) (hours: uint))
  (let* ((sender tx-sender)
         (offer (unwrap! (contract-call? .service-offer get-offer offer-id) ERR_INVALID_OFFER))
         (req (unwrap! (contract-call? .service-request get-request request-id) ERR_INVALID_REQUEST))
         (id (var-get next-id)))
    (asserts! (and (get active offer) (get active req)) ERR_INVALID_OFFER)
    (asserts! (is-eq sender (get requester req)) ERR_NOT_AUTHORIZED)
    (asserts! (>= (contract-call? .care-hour-token get-balance sender) hours) ERR_INSUFFICIENT_BALANCE)
    ;; Transfer to escrow (this contract holds)
    (try! (contract-call? .care-hour-token transfer hours sender (as-contract tx-sender)))
    (map-set bookings id {offer-id: offer-id, request-id: request-id, provider: (get provider offer), requester: sender, hours: hours, escrowed: true})
    (var-set next-id (+ id u1))
    (ok id)))

(define-read-only (get-booking (id: uint))
  (map-get? bookings id))
```

### 6. verification.clar (Verification and Settlement)

```clarity
;; verification.clar
;; Verifies completion and releases escrow

(define-constant ERR_NOT_PARTY (err u600))
(define-constant ERR_ALREADY_VERIFIED (err u601))

(define-map verifications uint {verified: bool, rating: uint, timestamp: uint})

(define-public (verify-completion (booking-id: uint) (satisfied: bool) (rating: uint))
  (let* ((booking (unwrap! (contract-call? .booking get-booking booking-id) ERR_INVALID_OFFER))
         (sender tx-sender)
         (provider (get provider booking))
         (requester (get requester booking)))
    (asserts! (or (is-eq sender provider) (is-eq sender requester)) ERR_NOT_PARTY)
    (asserts! (not (map-get? verifications booking-id)) ERR_ALREADY_VERIFIED)
    (map-set verifications booking-id {verified: satisfied, rating: rating, timestamp: block-height})
    (if satisfied
      ;; Release escrow to provider
      (begin
        (try! (as-contract (contract-call? .care-hour-token transfer (get hours booking) tx-sender provider)))
        ;; Update ratings
        (try! (contract-call? .user-profile update-rating requester rating))
        (try! (contract-call? .user-profile update-rating provider (/ u100 rating))) ;; Reciprocal
        (ok true))
      ;; Dispute: Hold for oracle (simplified; extend with time-lock)
      (err u602)))) ;; Initiate dispute

(define-read-only (get-verification (booking-id: uint))
  (map-get? verifications booking-id))
```

## Deployment

1. Compile and test:
   ```
   clarinet check
   clarinet test
   ```

2. Deploy script (`deploy.sh`):
   ```bash
   #!/bin/bash
   clarinet deploy --network testnet
   # Update frontend with contract addresses
   ```

3. Contract Addresses (post-deployment):
   - Use Clarinet console to query.

## Usage

1. **Register**: Call `register` on user-profile with skills list (e.g., [1,2] for care/tutoring).
2. **Offer Service**: Call `create-offer` with IPFS hash of details.
3. **Request Service**: Similar for `create-request`.
4. **Book**: Caller (requester) invokes `book-service`.
5. **Verify**: Provider calls `verify-completion` post-service; requester confirms.
6. **Mint Initial Tokens**: Admin mints for new users (e.g., 10 CH airdrop).

## Contributing

Fork, PR with tests. Focus on security audits for escrow flows.

## License

MIT. Built with ❤️ for mutual aid.