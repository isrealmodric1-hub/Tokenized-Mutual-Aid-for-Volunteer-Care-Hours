;; care-hour-token.clar
;; Sophisticated SIP-010 Compliant Fungible Token for CareHours in Mutual Aid Network
;; Features: Admin controls, multi-minter support, pausing, mint with metadata and records,
;; burning, detailed error handling, supply caps, and read-only getters for transparency.
;; Designed for tokenized volunteer hours: minting represents verified contributions,
;; transfers enable peer-to-peer exchanges, burning for retirement of hours.

;; Constants
(define-constant CONTRACT-OWNER tx-sender)
(define-constant MAX-SUPPLY u1000000000) ;; 1 billion hours max
(define-constant MAX-METADATA-LEN u500) ;; Max length for mint metadata

(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-PAUSED (err u101))
(define-constant ERR-INVALID-AMOUNT (err u102))
(define-constant ERR-INVALID-RECIPIENT (err u103))
(define-constant ERR-INVALID-MINTER (err u104))
(define-constant ERR-ALREADY-REGISTERED (err u105))
(define-constant ERR-METADATA-TOO-LONG (err u106))
(define-constant ERR-SUPPLY-EXCEEDED (err u107))
(define-constant ERR-INSUFFICIENT-BALANCE (err u108))
(define-constant ERR-INVALID-PRINCIPAL (err u109))
(define-constant ERR-NOT-OWNER (err u110))
(define-constant ERR-ALREADY-PAUSED (err u111))
(define-constant ERR-NOT-PAUSED (err u112))

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var admin principal CONTRACT-OWNER)
(define-data-var token-uri (optional (string-utf8 256)) none)
(define-data-var mint-counter uint u0)

;; Data Maps
(define-map balances principal uint)
(define-map minters principal bool)
(define-map mint-records uint
  {
    amount: uint,
    recipient: principal,
    metadata: (string-utf8 500),
    timestamp: uint,
    minter: principal
  }
)

;; Fungible Token Definition (SIP-010 Compliant)
(define-fungible-token care-hour MAX-SUPPLY)

;; Private Functions
(define-private (is-admin (caller principal))
  (is-eq caller (var-get admin)))

(define-private (is-minter (caller principal))
  (default-to false (map-get? minters caller)))

(define-private (can-mint (amount uint))
  (and
    (not (var-get contract-paused))
    (<= (+ (ft-get-supply care-hour) amount) MAX-SUPPLY)))

;; Public Functions (SIP-010 Required)
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (not (is-eq recipient 'SP000000000000000000002Q6VF78)) ERR-INVALID-RECIPIENT) ;; Example invalid (burn address placeholder)
    (asserts! (>= (unwrap-panic (get-balance sender)) amount) ERR-INSUFFICIENT-BALANCE)
    (try! (ft-transfer? care-hour amount sender recipient))
    (ok true)))

(define-public (get-name)
  (ok "CareHour"))

(define-public (get-symbol)
  (ok "CH"))

(define-public (get-decimals)
  (ok u0)) ;; Whole hours

(define-public (get-balance (account principal))
  (ok (ft-get-balance care-hour account)))

(define-public (get-total-supply)
  (ok (ft-get-supply care-hour)))

(define-public (get-token-uri)
  (ok (var-get token-uri)))

;; Custom Public Functions
(define-public (mint (amount uint) (recipient principal) (metadata (string-utf8 500)))
  (let
    (
      (caller tx-sender)
      (current-supply (ft-get-supply care-hour))
    )
    (asserts! (is-minter caller) ERR-INVALID-MINTER)
    (asserts! (can-mint amount) ERR-PAUSED) ;; Also checks supply
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (not (is-eq recipient CONTRACT-OWNER)) ERR-INVALID-RECIPIENT) ;; Prevent mint to owner directly
    (asserts! (<= (len metadata) MAX-METADATA-LEN) ERR-METADATA-TOO-LONG)
    (try! (ft-mint? care-hour amount recipient))
    (let
      (
        (record-id (+ (var-get mint-counter) u1))
      )
      (map-set mint-records record-id
        {
          amount: amount,
          recipient: recipient,
          metadata: metadata,
          timestamp: block-height,
          minter: caller
        }
      )
      (var-set mint-counter record-id)
      (ok true))))

(define-public (burn (amount uint))
  (let
    (
      (caller tx-sender)
      (current-balance (ft-get-balance care-hour caller))
    )
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (> amount u0) ERR-INVALID-AMOUNT)
    (asserts! (>= current-balance amount) ERR-INSUFFICIENT-BALANCE)
    (try! (ft-burn? care-hour amount caller))
    (ok true)))

(define-public (add-minter (new-minter principal))
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (not (is-minter new-minter)) ERR-ALREADY-REGISTERED)
    (map-set minters new-minter true)
    (ok true)))

(define-public (remove-minter (minter principal))
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (map-set minters minter false)
    (ok true)))

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (not (is-eq new-admin tx-sender)) ERR-INVALID-PRINCIPAL)
    (var-set admin new-admin)
    (ok true)))

(define-public (pause-contract)
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (not (var-get contract-paused)) ERR-ALREADY-PAUSED)
    (var-set contract-paused true)
    (ok true)))

(define-public (unpause-contract)
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (asserts! (var-get contract-paused) ERR-NOT-PAUSED)
    (var-set contract-paused false)
    (ok true)))

(define-public (set-token-uri (new-uri (optional (string-utf8 256))))
  (begin
    (asserts! (is-admin tx-sender) ERR-NOT-AUTHORIZED)
    (var-set token-uri new-uri)
    (ok true)))

;; Read-Only Functions
(define-read-only (is-contract-paused)
  (var-get contract-paused))

(define-read-only (get-admin)
  (var-get admin))

(define-read-only (check-is-minter (account principal))
  (is-minter account))

(define-read-only (get-mint-record (record-id uint))
  (map-get? mint-records record-id))

(define-read-only (get-mint-counter)
  (var-get mint-counter))

;; Initialization
(begin
  ;; Set initial minter (deployer)
  (map-set minters CONTRACT-OWNER true)
  ;; Optional: Set initial URI
  (var-set token-uri (some u"https://carechain.example/token-metadata.json")))