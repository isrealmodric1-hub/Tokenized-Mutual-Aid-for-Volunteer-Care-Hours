;; verification.clar
;; Advanced Verification Contract for CareChain
;; Handles service completion verification, escrow release, dispute resolution,
;; evidence submission, multi-party consensus, and integration with reputation/profile systems.
;; Core: Ensures trust in mutual aid exchanges by providing robust, tamper-proof verification.

(define-constant ERR_NOT_PARTY (err u600))
(define-constant ERR_ALREADY_VERIFIED (err u601))
(define-constant ERR_INVALID_RATING (err u602))
(define-constant ERR_DISPUTE_IN_PROGRESS (err u603))
(define-constant ERR_EVIDENCE_TOO_LARGE (err u604))
(define-constant ERR_NO_ESCROW (err u605))
(define-constant ERR_ORACLE_NOT_CALLED (err u606))
(define-constant ERR_CONSENSUS_NOT_REACHED (err u607))
(define-constant ERR_REVOCATION_NOT_ALLOWED (err u608))
(define-constant ERR_INVALID_EVIDENCE_HASH (err u609))

;; Main verification map: Tracks verification state per booking
(define-map verifications
  { booking-id: uint }
  {
    verified: bool,
    rating: uint,
    timestamp: uint,
    verifier: principal,
    evidence-hash: (optional (buff 32)),
    dispute-active: bool,
    dispute-evidence: (list 5 (buff 32)),
    consensus-count: uint,
    total-parties: uint,
    oracle-called: bool,
    revocation-reason: (optional (string-utf8 200))
  }
)

;; Dispute resolution map
(define-map disputes
  { booking-id: uint }
  {
    initiated-at: uint,
    timeout-block: uint,
    oracle-response: (optional bool),
    resolution-timestamp: (optional uint),
    fee-paid: uint
  }
)

;; Evidence registry
(define-map evidence-log
  { booking-id: uint, submission-id: uint }
  {
    hash: (buff 32),
    submitter: principal,
    timestamp: uint,
    description: (string-utf8 100),
    verified: bool
  }
)

(define-data-var next-submission-id uint u1)
(define-data-var admin principal tx-sender)

;; Helper: Check if caller is a party
(define-private (is-party (booking-id uint) (caller principal))
  (let ((booking-opt (contract-call? .booking get-booking booking-id)))
    (if (is-none booking-opt)
      false
      (let ((booking (unwrap-panic booking-opt)))
        (or (is-eq caller (get provider booking))
            (is-eq caller (get requester booking)))))))

;; Helper: Validate rating
(define-private (valid-rating (rating uint))
  (and (>= rating u0) (<= rating u100)))

;; Read-only: Get verification state
(define-read-only (get-verification-state (booking-id uint))
  (map-get? verifications { booking-id: booking-id }))

;; Read-only: Get dispute state
(define-read-only (get-dispute-state (booking-id uint))
  (map-get? disputes { booking-id: booking-id }))

;; Core: Initiate verification
(define-public (initiate-verification
  (booking-id uint)
  (satisfied bool)
  (rating (optional uint))
  (evidence-hash (optional (buff 32))))
  (let* (
    (caller tx-sender)
    (existing-verif (map-get? verifications { booking-id: booking-id }))
    (booking-opt (contract-call? .booking get-booking booking-id))
  )
    (asserts! (is-party booking-id caller) ERR_NOT_PARTY)
    (asserts! (is-some booking-opt) ERR_NO_ESCROW)
    (let ((booking (unwrap-panic booking-opt)))
      (asserts! (get escrowed booking) ERR_NO_ESCROW)
      (asserts! (is-none existing-verif) ERR_ALREADY_VERIFIED)
      (asserts! (is-none (map-get? disputes { booking-id: booking-id })) ERR_DISPUTE_IN_PROGRESS))

    (if (is-some rating)
      (asserts! (valid-rating (unwrap-panic rating)) ERR_INVALID_RATING)
      true)

    (if (is-some evidence-hash)
      (asserts! (is-some (some (unwrap-panic evidence-hash))) ERR_INVALID_EVIDENCE_HASH)
      true)

    (let (
      (new-rating (if (is-some rating) (unwrap-panic rating) u0))
      (verif-entry {
        verified: satisfied,
        rating: new-rating,
        timestamp: block-height,
        verifier: caller,
        evidence-hash: evidence-hash,
        dispute-active: false,
        dispute-evidence: (list),
        consensus-count: u1,
        total-parties: u2,
        oracle-called: false,
        revocation-reason: none
      })
    )
      (map-set verifications { booking-id: booking-id } verif-entry)

      (if (is-some evidence-hash)
        (let ((sub-id (var-get next-submission-id)))
          (map-set evidence-log
            { booking-id: booking-id, submission-id: sub-id }
            {
              hash: (unwrap-panic evidence-hash),
              submitter: caller,
              timestamp: block-height,
              description: (if satisfied "Service completed" "Service disputed"),
              verified: satisfied
            })
          (var-set next-submission-id (+ (var-get next-submission-id) u1)))
        true)

      (if satisfied
        (begin
          (try! (release-escrow booking-id caller))
          (try! (update-reputations booking-id new-rating))
          (ok { state: verif-entry, action: "released" }))
        (begin
          (map-set verifications { booking-id: booking-id }
            (merge verif-entry { dispute-active: true }))
          (ok { state: verif-entry, action: "pending-dispute" }))))
  )
)

;; Release escrow to provider
(define-private (release-escrow (booking-id uint) (verifier principal))
  (let* (
    (booking-opt (contract-call? .booking get-booking booking-id))
    (booking (unwrap! booking-opt ERR_NO_ESCROW))
    (hours (get hours booking))
    (provider (get provider booking))
  )
    (try! (as-contract (contract-call? .care-hour-token transfer hours tx-sender provider)))
    (ok true)
  )
)

;; Update reputations
(define-private (update-reputations (booking-id uint) (rating uint))
  (let* (
    (verif-opt (map-get? verifications { booking-id: booking-id }))
    (verif (unwrap! verif-opt ERR_ALREADY_VERIFIED))
    (booking-opt (contract-call? .booking get-booking booking-id))
    (booking (unwrap! booking-opt ERR_NO_ESCROW))
    (requester (get requester booking))
    (provider (get provider booking))
    (reciprocal-rating (if (> rating u50) (- u100 rating) rating))
  )
    (try! (contract-call? .user-profile update-rating requester rating))
    (try! (contract-call? .user-profile update-rating provider reciprocal-rating))
    (ok true)
  )
)

;; Submit additional evidence
(define-public (submit-evidence (booking-id uint) (evidence-hash (buff 32)) (description (string-utf8 100)))
  (let (
    (caller tx-sender)
    (verif-opt (map-get? verifications { booking-id: booking-id }))
  )
    (asserts! (is-party booking-id caller) ERR_NOT_PARTY)
    (asserts! (is-some verif-opt) ERR_ALREADY_VERIFIED)
    (let (
      (verif (unwrap-panic verif-opt))
      (sub-id (var-get next-submission-id))
    )
      (map-set evidence-log
        { booking-id: booking-id, submission-id: sub-id }
        {
          hash: evidence-hash,
          submitter: caller,
          timestamp: block-height,
          description: description,
          verified: false
        })
      (var-set next-submission-id (+ (var-get next-submission-id) u1))

      (if (get dispute-active verif)
        (let (
          (current-evidence (get dispute-evidence verif))
          (updated-evidence (unwrap! (as-max-len? (append current-evidence evidence-hash) u5) ERR_EVIDENCE_TOO_LARGE))
        )
          (map-set verifications { booking-id: booking-id }
            (merge verif { dispute-evidence: updated-evidence }))
          (ok { action: "evidence-added-to-dispute", sub-id: sub-id }))
        (begin
          (map-set verifications { booking-id: booking-id }
            (merge verif { evidence-hash: (some evidence-hash) }))
          (ok { action: "evidence-updated", sub-id: sub-id }))))
  )
)

;; Initiate dispute
(define-public (initiate-dispute (booking-id uint) (fee uint))
  (let* (
    (caller tx-sender)
    (verif-opt (map-get? verifications { booking-id: booking-id }))
    (verif (unwrap! verif-opt ERR_ALREADY_VERIFIED))
  )
    (asserts! (is-party booking-id caller) ERR_NOT_PARTY)
    (asserts! (get dispute-active verif) ERR_DISPUTE_IN_PROGRESS)
    (asserts! (> fee u0) ERR_INVALID_RATING)

    (try! (contract-call? .care-hour-token transfer fee caller (var-get admin)))

    (map-set disputes { booking-id: booking-id }
      {
        initiated-at: block-height,
        timeout-block: (+ block-height u144),
        oracle-response: none,
        resolution-timestamp: none,
        fee-paid: fee
      })
    (ok { dispute-id: booking-id, timeout: (+ block-height u144) })
  )
)

;; Resolve dispute (admin/oracle)
(define-public (resolve-dispute (booking-id uint) (in-favor-requester bool))
  (let (
    (caller tx-sender)
    (dispute-opt (map-get? disputes { booking-id: booking-id }))
  )
    (asserts! (is-eq caller (var-get admin)) ERR_NOT_PARTY)
    (asserts! (is-some dispute-opt) ERR_DISPUTE_IN_PROGRESS)
    (let* (
      (dispute (unwrap-panic dispute-opt))
      (verif-opt (map-get? verifications { booking-id: booking-id }))
      (verif (unwrap! verif-opt ERR_ALREADY_VERIFIED))
    )
      (asserts! (<= block-height (get timeout-block dispute)) ERR_DISPUTE_IN_PROGRESS)

      (map-set disputes { booking-id: booking-id }
        (merge dispute {
          oracle-response: (some in-favor-requester),
          resolution-timestamp: (some block-height)
        }))

      (let (
        (final-satisfied (not in-favor-requester))
        (final-rating (if in-favor-requester u0 u100))
      )
        (map-set verifications { booking-id: booking-id }
          (merge verif {
            verified: final-satisfied,
            rating: final-rating,
            oracle-called: true
          }))

        (if final-satisfied
          (begin
            (try! (release-escrow booking-id tx-sender))
            (try! (update-reputations booking-id final-rating))
            (ok { outcome: "provider-paid", rating: final-rating }))
          (begin
            (let ((hours (get hours (unwrap-panic (contract-call? .booking get-booking booking-id)))))
              (try! (as-contract (contract-call? .care-hour-token transfer hours tx-sender (get requester verif)))))
            (ok { outcome: "requester-refunded", rating: final-rating })))))
  )
)

;; Multi-party consensus
(define-public (confirm-consensus (booking-id uint) (agrees bool))
  (let* (
    (caller tx-sender)
    (verif-opt (map-get? verifications { booking-id: booking-id }))
    (verif (unwrap! verif-opt ERR_ALREADY_VERIFIED))
  )
    (asserts! (is-party booking-id caller) ERR_NOT_PARTY)
    (asserts! (< (get consensus-count verif) (get total-parties verif)) ERR_CONSENSUS_NOT_REACHED)

    (let (
      (new-count (+ (get consensus-count verif) u1))
      (updated-verif (merge verif { consensus-count: new-count }))
    )
      (map-set verifications { booking-id: booking-id } updated-verif)

      (if (is-eq new-count (get total-parties verif))
        (begin
          (map-set verifications { booking-id: booking-id }
            (merge updated-verif { verified: agrees }))
          (if agrees
            (begin
              (try! (release-escrow booking-id caller))
              (try! (update-reputations booking-id (get rating verif)))
              (ok { status: "consensus-reached", finalized: true }))
            (begin
              (try! (initiate-dispute booking-id u10))
              (ok { status: "consensus-dispute", finalized: false }))))
        (ok { status: "consensus-pending", count: new-count }))))
)

;; Revoke verification
(define-public (revoke-verification (booking-id uint) (reason (string-utf8 200)))
  (let* (
    (caller tx-sender)
    (verif-opt (map-get? verifications { booking-id: booking-id }))
    (verif (unwrap! verif-opt ERR_ALREADY_VERIFIED))
    (timestamp (- block-height (get timestamp verif)))
  )
    (asserts! (or (is-eq caller (var-get admin)) (is-party booking-id caller)) ERR_NOT_PARTY)
    (asserts! (<= timestamp u10) ERR_REVOCATION_NOT_ALLOWED)

    (map-set verifications { booking-id: booking-id }
      (merge verif {
        verified: false,
        dispute-active: true,
        revocation-reason: (some reason)
      }))
    (ok { action: "revoked", reason: reason })
  )
)

;; Read-only: Get evidence
(define-read-only (get-evidence (booking-id uint) (submission-id uint))
  (map-get? evidence-log { booking-id: booking-id, submission-id: submission-id }))

;; Admin: Set total parties
(define-public (set-total-parties (booking-id uint) (total uint))
  (asserts! (is-eq tx-sender (var-get admin)) ERR_NOT_PARTY)
  (asserts! (> total u0) ERR_INVALID_RATING)
  (let ((verif-opt (map-get? verifications { booking-id: booking-id })))
    (if (is-some verif-opt)
      (let ((verif (unwrap-panic verif-opt)))
        (map-set verifications { booking-id: booking-id }
          (merge verif { total-parties: total }))
        (ok true))
      ERR_ALREADY_VERIFIED)))

;; Cleanup old verifications
(define-public (cleanup-old-verification (booking-id uint))
  (asserts! (is-eq tx-sender (var-get admin)) ERR_NOT_PARTY)
  (let (
    (verif-opt (map-get? verifications { booking-id: booking-id }))
    (dispute-opt (map-get? disputes { booking-id: booking-id }))
  )
    (if (and (is-some verif-opt) (is-some dispute-opt))
      (let* (
        (dispute (unwrap-panic dispute-opt))
        (verif (unwrap-panic verif-opt))
      )
        (if (> block-height (get timeout-block dispute))
          (begin
            (map-delete verifications { booking-id: booking-id })
            (map-delete disputes { booking-id: booking-id })
            (ok { cleaned: true }))
          ERR_DISPUTE_IN_PROGRESS))
      ERR_ALREADY_VERIFIED)))