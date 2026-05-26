use std::collections::HashMap;

use crate::cache::entitlements::EntitlementRow;

use super::types::EntitlementWire;

pub fn map_to_rows(map: HashMap<String, EntitlementWire>, updated_at_ms: u64) -> Vec<EntitlementRow> {
    map.into_iter()
        .map(|(key, w)| EntitlementRow {
            entitlement_id: key,
            is_active: w.is_active,
            product_id: Some(w.product_identifier.clone()),
            product_identifier: w.product_identifier,
            store: w.store,
            expires_iso: w.expires_date.clone(),
            expires_at_ms: w.expires_date.as_deref().and_then(parse_iso_to_ms),
            updated_at_ms,
        })
        .collect()
}

fn parse_iso_to_ms(iso: &str) -> Option<u64> {
    // Minimal RFC3339 parser: server emits `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
    // On parse failure return None so the row still inserts (expires_iso is the
    // source of truth; expires_at_ms is a denorm convenience).
    let primitive = iso.strip_suffix('Z').unwrap_or(iso);
    let mut parts = primitive.splitn(2, 'T');
    let date = parts.next()?;
    let time = parts.next()?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let m: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let (hms, ms_frac) = match time.split_once('.') {
        Some((a, b)) => (a, b.trim_end_matches('Z')),
        None => (time, "0"),
    };
    let mut t = hms.split(':');
    let h: u32 = t.next()?.parse().ok()?;
    let mn: u32 = t.next()?.parse().ok()?;
    let s: u32 = t.next()?.parse().ok()?;
    let ms: u64 = ms_frac.chars().take(3).collect::<String>().parse().unwrap_or(0);

    // Days from civil (Howard Hinnant).
    let yy = if m <= 2 { y - 1 } else { y };
    let era = (if yy >= 0 { yy } else { yy - 399 }) / 400;
    let yoe = (yy - era * 400) as u64;
    let mp = if m > 2 { m as u64 - 3 } else { m as u64 + 9 };
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146_097 + doe as i64 - 719_468;
    let secs = days_since_epoch * 86_400 + (h as i64) * 3600 + (mn as i64) * 60 + s as i64;
    if secs < 0 {
        return None;
    }
    Some((secs as u64) * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_z_iso_to_ms() {
        let ms = parse_iso_to_ms("2030-01-01T00:00:00.000Z").unwrap();
        assert_eq!(ms, 1_893_456_000_000);
    }

    #[test]
    fn parses_without_fraction() {
        let ms = parse_iso_to_ms("2030-01-01T00:00:00Z").unwrap();
        assert_eq!(ms, 1_893_456_000_000);
    }
}
