// P2.1: who a screen is. The same rules as packages/domain/src/screen-identity.ts, checked against
// the same shared cases (packages/domain/test-vectors/screen-identity.json).
package app.recall.player.core

/** Crockford base32: no I, L, O or U, so ids read aloud and typed by hand stay clear. */
private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
private val SCREEN_ID = Regex("^SCR-[0-9A-HJKMNP-TV-Z]{8}$")
private val QR = Regex("^RECALL1:(SCR-[0-9A-Z]{8})$")
private val STATE_PLATE = Regex("^([A-Z]{2})(\\d{1,2})([A-Z]{1,3})(\\d{1,4})$")
private val BHARAT_PLATE = Regex("^(\\d{2})BH(\\d{4})([A-Z]{1,2})$")
/** Only these are trimmed or dropped, so the cloud (TypeScript) agrees exactly. */
private val ASCII_EDGES = Regex("^[ \\t\\r\\n]+|[ \\t\\r\\n]+$")
private val PLATE_GAPS = Regex("[ .-]")

object ScreenIdentity {
    /** Luhn mod 32 check character: catches every single wrong character and most swaps. */
    fun checkCharacter(body: String): Char {
        var factor = 2
        var sum = 0
        for (i in body.indices.reversed()) {
            val code = ALPHABET.indexOf(body[i])
            require(code >= 0) { "Not a screen id character: ${body[i]}" }
            var addend = factor * code
            factor = if (factor == 2) 1 else 2
            addend = addend / 32 + addend % 32
            sum += addend
        }
        return ALPHABET[(32 - sum % 32) % 32]
    }

    /** A new screen id from 7 random values 0–31 (from a secure random source on the box). */
    fun newScreenId(random: List<Int>): String {
        require(random.size == 7 && random.all { it in 0..31 }) { "A screen id needs 7 random values 0–31" }
        val body = random.map { ALPHABET[it] }.joinToString("")
        return "SCR-$body${checkCharacter(body)}"
    }

    fun isScreenId(id: String): Boolean =
        SCREEN_ID.matches(id) && checkCharacter(id.substring(4, 11)) == id[11]

    /** What the QR sticker on a screen says. */
    fun qr(screenId: String): String = "RECALL1:$screenId"

    /** The screen id in a scanned QR, or null when it is not a RECALL screen's QR. */
    fun screenIdFromQr(text: String): String? {
        val id = QR.matchEntire(text.replace(ASCII_EDGES, ""))?.groupValues?.get(1) ?: return null
        return if (isScreenId(id)) id else null
    }

    /**
     * An Indian number plate in one form ("ts 9 ea 12" → "TS09EA0012"), or null when it is not one:
     * the district gets two digits and the number four, so one bike is never two.
     */
    fun numberPlate(text: String): String? {
        val p = text.uppercase().replace(PLATE_GAPS, "")
        STATE_PLATE.matchEntire(p)?.destructured?.let { (st, district, series, num) ->
            if (district.toInt() == 0 || num.toInt() == 0) return null
            return st + district.padStart(2, '0') + series + num.padStart(4, '0')
        }
        BHARAT_PLATE.matchEntire(p)?.destructured?.let { (year, num, _) ->
            return if (year.toInt() >= 21 && num.toInt() > 0) p else null
        }
        return null
    }
}
