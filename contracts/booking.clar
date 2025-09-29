;; booking.clar
;; Core contract for handling bookings in CareChain: manages matching of service offers and requests,
;; escrows CareHours tokens, tracks booking status, handles cancellations, disputes, and resolutions.
;; Expanded for robustness: includes admin controls, timeouts, events, and detailed error handling.
;; Assumes integration with other contracts like .care-hour-token, .service-offer, .service-request, .user-profile, .verification.

(define-constant ERR_NOT_AUTHORIZED (err u100))
(define-constant ERR_INVALID_OFFER (err u300))
(define-constant ERR_INVALID_REQUEST (err u400))
(define-constant ERR_INSUFFICIENT_BALANCE (err u500))
(define-constant ERR_ALREADY_BOOKED (err u501))
(define-constant ERR_BOOKING_NOT_FOUND (err u502))
(define-constant ERR_INVALID_STATUS (err u503))
(define-constant ERR_DISPUTE_ACTIVE (err u504))
(define-constant ERR_NO_DISPUTE (err u505))
(define-constant ERR_CONTRACT_PAUSED (err u506))
(define-constant ERR_INVALID_AMOUNT (err u507))
(define-constant ERR_TIMEOUT_NOT_REACHED (err u508))
(define-constant ERR_INVALID_METADATA (err u509))

(define-constant STATUS_PENDING u0)
(define-constant STATUS_ACTIVE u1)
(define-constant STATUS_COMPLETED u2)
(define-constant STATUS_CANCELLED u3)
(define-constant STATUS_DISPUTED u4)
(define-constant STATUS_RESOLVED u5)

(define-constant MAX_METADATA_LEN u256) ;; Max length for metadata buff
(define-constant DISPUTE_TIMEOUT u144) ;; ~1 day in blocks (assuming 10-min blocks)

(define-data-var admin principal tx-sender)
(define-data-var paused bool false)
(define-data-var next-booking-id uint u1)

(define-map bookings uint 
  {
    offer-id: uint,
    request-id: uint,
    provider: principal,
    requester: principal,
    hours: uint,
    escrowed-amount: uint,
    status: uint,
    start-block: (optional uint),
    end-block: (optional uint),
    metadata: (buff 256), ;; IPFS hash or encoded details
    dispute-block: (optional uint)
  }
)

(define-map booking-disputes uint 
  {
    reason: (string-utf8 200),
    initiator: principal,
    evidence-hash: (buff 32) ;; Hash of off-chain evidence
  }
)

;; Event emitter helper
(define-private (emit-event (event-type (string-ascii 32)) (data {booking-id: uint, details: (string-utf8 100)}))
  (print {type: event-type, data: data})
  (ok true)
)

(define-public (book-service (offer-id uint) (request-id uint) (hours uint) (metadata (buff 256)))
  (let 
    (
      (sender tx-sender)
      (offer (unwrap! (contract-call? .service-offer get-offer offer-id) ERR_INVALID_OFFER))
      (req (unwrap! (contract-call? .service-request get-request request-id) ERR_INVALID_REQUEST))
      (id (var-get next-booking-id))
      (profile (unwrap! (contract-call? .user-profile get-profile sender) ERR_NOT_AUTHORIZED))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (and (get active offer) (get active req)) ERR_INVALID_OFFER)
    (asserts! (is-eq sender (get requester req)) ERR_NOT_AUTHORIZED)
    (asserts! (> hours u0) ERR_INVALID_AMOUNT)
    (asserts! (<= (len metadata) MAX_METADATA_LEN) ERR_INVALID_METADATA)
    (asserts! (>= (contract-call? .care-hour-token get-balance sender) hours) ERR_INSUFFICIENT_BALANCE)
    ;; Escrow transfer
    (try! (contract-call? .care-hour-token transfer hours sender (as-contract tx-sender)))
    ;; Store booking
    (map-set bookings id 
      {
        offer-id: offer-id,
        request-id: request-id,
        provider: (get provider offer),
        requester: sender,
        hours: hours,
        escrowed-amount: hours,
        status: STATUS_PENDING,
        start-block: none,
        end-block: none,
        metadata: metadata,
        dispute-block: none
      }
    )
    (var-set next-booking-id (+ id u1))
    ;; Emit event
    (try! (emit-event "booking-created" {booking-id: id, details: u"New booking initiated"}))
    (ok id)
  )
)

(define-public (start-service (booking-id uint))
  (let 
    (
      (sender tx-sender)
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (or (is-eq sender (get provider booking)) (is-eq sender (get requester booking))) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq (get status booking) STATUS_PENDING) ERR_INVALID_STATUS)
    (map-set bookings booking-id 
      (merge booking 
        {
          status: STATUS_ACTIVE,
          start-block: (some block-height)
        }
      )
    )
    (try! (emit-event "service-started" {booking-id: booking-id, details: u"Service has begun"}))
    (ok true)
  )
)

(define-public (complete-service (booking-id uint))
  (let 
    (
      (sender tx-sender)
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (is-eq sender (get provider booking)) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq (get status booking) STATUS_ACTIVE) ERR_INVALID_STATUS)
    (map-set bookings booking-id 
      (merge booking 
        {
          status: STATUS_COMPLETED,
          end-block: (some block-height)
        }
      )
    )
    ;; Release escrow to provider
    (try! (as-contract (contract-call? .care-hour-token transfer (get escrowed-amount booking) tx-sender (get provider booking))))
    (try! (emit-event "service-completed" {booking-id: booking-id, details: u"Service completed and funds released"}))
    ;; Update profiles (ratings, hours)
    (try! (contract-call? .user-profile update-rating (get provider booking) u90)) ;; Placeholder rating
    (try! (contract-call? .user-profile update-rating (get requester booking) u90))
    (ok true)
  )
)

(define-public (cancel-booking (booking-id uint))
  (let 
    (
      (sender tx-sender)
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (or (is-eq sender (get provider booking)) (is-eq sender (get requester booking))) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq (get status booking) STATUS_PENDING) ERR_INVALID_STATUS)
    ;; Refund escrow to requester
    (try! (as-contract (contract-call? .care-hour-token transfer (get escrowed-amount booking) tx-sender (get requester booking))))
    (map-set bookings booking-id (merge booking {status: STATUS_CANCELLED}))
    (try! (emit-event "booking-cancelled" {booking-id: booking-id, details: u"Booking cancelled with refund"}))
    (ok true)
  )
)

(define-public (initiate-dispute (booking-id uint) (reason (string-utf8 200)) (evidence-hash (buff 32)))
  (let 
    (
      (sender tx-sender)
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
      (reason-length (len reason))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (or (is-eq sender (get provider booking)) (is-eq sender (get requester booking))) ERR_NOT_AUTHORIZED)
    (asserts! (or (is-eq (get status booking) STATUS_ACTIVE) (is-eq (get status booking) STATUS_COMPLETED)) ERR_INVALID_STATUS)
    (asserts! (is-none (get dispute-block booking)) ERR_DISPUTE_ACTIVE)
    (asserts! (> reason-length u0) ERR_INVALID_METADATA) ;; Ensure reason is non-empty
    (map-set bookings booking-id 
      (merge booking 
        {
          status: STATUS_DISPUTED,
          dispute-block: (some block-height)
        }
      )
    )
    (map-set booking-disputes booking-id 
      {
        reason: reason,
        initiator: sender,
        evidence-hash: evidence-hash
      }
    )
    (try! (emit-event "dispute-initiated" {booking-id: booking-id, details: reason}))
    (ok true)
  )
)

(define-public (resolve-dispute (booking-id uint) (release-to-provider bool))
  (let 
    (
      (sender tx-sender)
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
      (dispute (unwrap! (map-get? booking-disputes booking-id) ERR_NO_DISPUTE))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (is-eq sender (var-get admin)) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq (get status booking) STATUS_DISPUTED) ERR_INVALID_STATUS)
    (if release-to-provider
      (try! (as-contract (contract-call? .care-hour-token transfer (get escrowed-amount booking) tx-sender (get provider booking))))
      (try! (as-contract (contract-call? .care-hour-token transfer (get escrowed-amount booking) tx-sender (get requester booking))))
    )
    (map-set bookings booking-id (merge booking {status: STATUS_RESOLVED}))
    (map-delete booking-disputes booking-id)
    (try! (emit-event "dispute-resolved" {booking-id: booking-id, details: (if release-to-provider u"Released to provider" u"Refunded to requester")}))
    (ok true)
  )
)

(define-public (timeout-refund (booking-id uint))
  (let 
    (
      (booking (unwrap! (map-get? bookings booking-id) ERR_BOOKING_NOT_FOUND))
      (dispute-start (unwrap! (get dispute-block booking) ERR_NO_DISPUTE))
    )
    (asserts! (not (var-get paused)) ERR_CONTRACT_PAUSED)
    (asserts! (is-eq (get status booking) STATUS_DISPUTED) ERR_INVALID_STATUS)
    (asserts! (> block-height (+ dispute-start DISPUTE_TIMEOUT)) ERR_TIMEOUT_NOT_REACHED)
    ;; Refund to requester by default on timeout
    (try! (as-contract (contract-call? .care-hour-token transfer (get escrowed-amount booking) tx-sender (get requester booking))))
    (map-set bookings booking-id (merge booking {status: STATUS_RESOLVED}))
    (map-delete booking-disputes booking-id)
    (try! (emit-event "dispute-timed-out" {booking-id: booking-id, details: u"Refunded due to timeout"}))
    (ok true)
  )
)

(define-public (set-admin (new-admin principal))
  (let
    (
      (sender tx-sender)
    )
    (asserts! (is-eq sender (var-get admin)) ERR_NOT_AUTHORIZED)
    (asserts! (not (is-eq new-admin sender)) ERR_NOT_AUTHORIZED) ;; Prevent self-assignment
    (var-set admin new-admin)
    (ok true)
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR_NOT_AUTHORIZED)
    (var-set paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR_NOT_AUTHORIZED)
    (var-set paused false)
    (ok true)
  )
)

(define-read-only (get-booking (id uint))
  (map-get? bookings id)
)

(define-read-only (get-booking-dispute (id uint))
  (map-get? booking-disputes id)
)

(define-read-only (get-next-id)
  (ok (var-get next-booking-id))
)

(define-read-only (is-paused)
  (ok (var-get paused))
)

(define-read-only (get-admin)
  (ok (var-get admin))
)