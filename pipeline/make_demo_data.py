"""Generate SYNTHETIC demo data and run the real adapters on it.

Nothing here is real. The CSVs mimic the column layout of the ICIJ Offshore Leaks
bulk export and of a Traffy Fondue ticket export, so the adapters (and the viewer)
can be developed and demoed without downloading the real datasets. Names, links,
dates and counts are invented.

    python pipeline/make_demo_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import offshore_adapter  # noqa: E402
import traffy_adapter  # noqa: E402

SAMPLE = HERE / "sample"
DAY = 86_400_000


def zipf(n, a):
    w = 1.0 / np.arange(1, n + 1) ** a
    return w / w.sum()


def icij_date(ts):
    return "" if ts is None else pd.Timestamp(ts).strftime("%d-%b-%Y").upper()


# ---------------------------------------------------------------------------- offshore
def make_offshore(seed=11):
    rng = np.random.default_rng(seed)
    out = SAMPLE / "offshore"
    out.mkdir(parents=True, exist_ok=True)

    countries = [("THA", "Thailand"), ("SGP", "Singapore"), ("HKG", "Hong Kong"),
                 ("CHE", "Switzerland"), ("GBR", "United Kingdom"), ("MYS", "Malaysia"),
                 ("JPN", "Japan"), ("AUS", "Australia"), ("USA", "United States"),
                 ("DEU", "Germany")]
    cw = np.array([0.30, 0.15, 0.15, 0.06, 0.07, 0.07, 0.05, 0.05, 0.05, 0.05])
    jur = [("BVI", "British Virgin Islands"), ("PMA", "Panama"), ("SEY", "Seychelles"),
           ("BAH", "Bahamas"), ("SAM", "Samoa"), ("NIUE", "Niue"), ("CYP", "Cyprus")]
    jw = np.array([0.45, 0.25, 0.10, 0.08, 0.06, 0.03, 0.03])
    ctypes = ["Standard International Company", "Business Company", "Foundation", "Trust"]
    nid = iter(range(10_000_001, 99_999_999))

    # intermediaries / officers / addresses
    n_int, n_off, n_adr, n_ent = 40, 1300, 90, 1700
    ints = [next(nid) for _ in range(n_int)]
    offs = [next(nid) for _ in range(n_off)]
    adrs = [next(nid) for _ in range(n_adr)]
    ents = [next(nid) for _ in range(n_ent)]

    def pick_country(k):
        idx = rng.choice(len(countries), size=k, p=cw / cw.sum())
        return [countries[i] for i in idx]

    # entities with lifespans
    wave = rng.choice([2001, 2006, 2011], size=n_ent, p=[0.3, 0.4, 0.3])
    inc_year = np.clip(rng.normal(wave, 2.0), 1995, 2016.9)
    inc = pd.to_datetime("1995-01-01") + pd.to_timedelta((inc_year - 1995) * 365.25, unit="D")
    inc = pd.Series(inc).dt.floor("D")
    has_end = rng.random(n_ent) < 0.58
    lag = rng.gamma(2.0, 4.0, n_ent) * 365.25
    end = inc + pd.to_timedelta(lag, unit="D")
    has_end &= (end < pd.Timestamp("2020-06-01")).to_numpy()
    use_struck = rng.random(n_ent) < 0.7
    missing_inc = rng.random(n_ent) < 0.07
    leak = np.where(inc_year < 2004, "Demo Leak A", np.where(inc_year < 2009, "Demo Leak B",
                    np.where(inc_year < 2013, "Demo Leak C", "Demo Leak D")))
    ent_c = pick_country(n_ent)
    ent_j = [jur[i] for i in rng.choice(len(jur), size=n_ent, p=jw)]
    rows = []
    for k, e in enumerate(ents):
        ended = bool(has_end[k])
        rows.append({
            "node_id": e, "name": f"{['Demo Holdings','Sample Capital','Mock Ventures','Test Trading','Example Investments'][k % 5]} {k:04d} Ltd",
            "jurisdiction": ent_j[k][0], "jurisdiction_description": ent_j[k][1],
            "company_type": ctypes[int(rng.integers(len(ctypes)))],
            "incorporation_date": "" if missing_inc[k] else icij_date(inc[k]),
            "inactivation_date": icij_date(end[k]) if ended and not use_struck[k] else "",
            "struck_off_date": icij_date(end[k]) if ended and use_struck[k] else "",
            "dorm_date": icij_date(end[k] - pd.Timedelta(days=200)) if ended and rng.random() < 0.06 else "",
            "status": ("Struck off" if use_struck[k] else "Inactive") if ended else "Active",
            "country_codes": ent_c[k][0], "countries": ent_c[k][1], "sourceID": leak[k],
        })
    pd.DataFrame(rows).to_csv(out / "nodes-entities.csv", index=False)

    oc = pick_country(n_off)
    pd.DataFrame({"node_id": offs,
                  "name": [f"Demo Person {k:04d}" if k % 9 else f"Demo Nominees {k:04d} Ltd" for k in range(n_off)],
                  "country_codes": [c[0] for c in oc], "countries": [c[1] for c in oc],
                  "sourceID": rng.choice(["Demo Leak A", "Demo Leak B", "Demo Leak C", "Demo Leak D"], n_off)}
                 ).to_csv(out / "nodes-officers.csv", index=False)
    ic = pick_country(n_int)
    pd.DataFrame({"node_id": ints, "name": [f"Demo Corporate Services {k:02d}" for k in range(n_int)],
                  "country_codes": [c[0] for c in ic], "countries": [c[1] for c in ic],
                  "status": "ACTIVE", "sourceID": "Demo Leak B"}).to_csv(out / "nodes-intermediaries.csv", index=False)
    ac = pick_country(n_adr)
    pd.DataFrame({"node_id": adrs, "address": [f"Demo Address {k:03d}, Fictional Street" for k in range(n_adr)],
                  "country_codes": [c[0] for c in ac], "countries": [c[1] for c in ac],
                  "sourceID": "Demo Leak C"}).to_csv(out / "nodes-addresses.csv", index=False)

    # relationships
    rel = []
    iw, ow, aw = zipf(n_int, 1.0), zipf(n_off, 0.9), zipf(n_adr, 1.2)
    link_types = ["shareholder of", "director of", "beneficial owner of", "nominee shareholder of"]
    for k, e in enumerate(ents):
        rel.append((ints[rng.choice(n_int, p=iw)], e, "intermediary_of", "intermediary of", "", "", leak[k]))
        rel.append((e, adrs[rng.choice(n_adr, p=aw)], "registered_address", "registered address", "", "", leak[k]))
        for _ in range(min(5, 1 + rng.poisson(1.2))):
            o = offs[rng.choice(n_off, p=ow)] if rng.random() < 0.85 else offs[int(rng.integers(n_off))]
            s = e_ = ""
            if rng.random() < 0.6 and not missing_inc[k]:
                st = inc[k] + pd.Timedelta(days=int(rng.integers(0, 400)))
                s = icij_date(st)
                if has_end[k] and rng.random() < 0.5:
                    e_ = icij_date(end[k])
            rel.append((o, e, "officer_of", link_types[int(rng.integers(4))], s, e_, leak[k]))
        if rng.random() < 0.07:
            other = ents[int(rng.integers(n_ent))]
            if other != e:
                rel.append((e, other, "related_entity", "similar name and address as", "", "", leak[k]))
    for o in offs:
        if rng.random() < 0.4:
            rel.append((o, adrs[rng.choice(n_adr, p=aw)], "registered_address", "registered address", "", "", "Demo Leak C"))
    pd.DataFrame(rel, columns=["node_id_start", "node_id_end", "rel_type", "link",
                               "start_date", "end_date", "sourceID"]).to_csv(out / "relationships.csv", index=False)
    return out


# ---------------------------------------------------------------------------- traffy
DISTRICTS = """Phra Nakhon,Dusit,Nong Chok,Bang Rak,Bang Khen,Bang Kapi,Pathum Wan,Pom Prap Sattru Phai,
Phra Khanong,Min Buri,Lat Krabang,Yan Nawa,Samphanthawong,Phaya Thai,Thon Buri,Bangkok Yai,Huai Khwang,
Khlong San,Taling Chan,Bangkok Noi,Bang Khun Thian,Phasi Charoen,Nong Khaem,Rat Burana,Bang Phlat,Din Daeng,
Bueng Kum,Sathon,Bang Sue,Chatuchak,Bang Kho Laen,Prawet,Khlong Toei,Suan Luang,Chom Thong,Don Mueang,
Ratchathewi,Lat Phrao,Watthana,Bang Khae,Lak Si,Sai Mai,Khan Na Yao,Saphan Sung,Wang Thonglang,
Khlong Sam Wa,Bang Na,Thawi Watthana,Thung Khru,Bang Bon""".replace("\n", "").split(",")
CATS = ["Road", "Sidewalk", "Flood", "Light", "Safety", "Cleanliness", "Drain", "Bridge", "Traffic"]
AGENCY = {"Road": "Public Works Dept.", "Sidewalk": "Public Works Dept.", "Bridge": "Public Works Dept.",
          "Flood": "Drainage & Sewerage Dept.", "Drain": "Drainage & Sewerage Dept.",
          "Light": "Public Lighting Division", "Safety": "Municipal Enforcement Dept.",
          "Cleanliness": "Environment Dept.", "Traffic": "Traffic & Transport Dept."}


def make_traffy(seed=5, n=60_000):
    rng = np.random.default_rng(seed)
    out = SAMPLE / "traffy"
    out.mkdir(parents=True, exist_ok=True)
    districts = [d.strip() for d in DISTRICTS]
    nd, nc = len(districts), len(CATS)
    cidx = {c: i for i, c in enumerate(CATS)}

    aff = rng.gamma(3.0, 1.0, (nd, nc))
    flood_prone = rng.choice(nd, 12, replace=False)
    central = rng.choice(nd, 10, replace=False)
    outer = rng.choice(nd, 12, replace=False)
    aff[np.ix_(flood_prone, [cidx["Flood"], cidx["Drain"]])] *= 3.2
    aff[np.ix_(central, [cidx["Traffic"], cidx["Sidewalk"]])] *= 2.6
    aff[np.ix_(outer, [cidx["Road"], cidx["Light"]])] *= 2.0
    vol = rng.lognormal(0, 0.5, nd)
    vol /= vol.sum()

    start = pd.Timestamp("2022-06-01")
    days = pd.date_range(start, "2026-10-31", freq="D")
    t = np.arange(len(days))
    doy = days.dayofyear.to_numpy()
    season = np.exp(-(((doy - 270) / 35.0) ** 2))
    intensity = (0.35 + 1.0 * (1 - np.exp(-t / 220.0))) * (1 + 0.5 * season)
    intensity /= intensity.sum()

    day_i = rng.choice(len(days), size=n, p=intensity)
    d_i = rng.choice(nd, size=n, p=vol)
    mult = np.ones((len(days), nc))
    mult[:, cidx["Flood"]] += 3.0 * season
    mult[:, cidx["Drain"]] += 1.8 * season
    mult[:, cidx["Traffic"]] *= 1 + t / len(days)
    W = aff[d_i] * mult[day_i]
    cum = W.cumsum(1)
    c_i = (cum < (rng.random(n) * cum[:, -1])[:, None]).sum(1)

    secs = rng.integers(6 * 3600, 22 * 3600, n)
    ts = days[day_i] + pd.to_timedelta(secs, unit="s")
    age = (days[-1] - days[day_i]).days.to_numpy()
    p_fin = np.where(age > 30, 0.86, 0.5)
    u = rng.random(n)
    state = np.where(u < p_fin, "finished", np.where(u < p_fin + (1 - p_fin) * 0.5, "in_progress", "reported"))
    lag = np.where(state == "finished", rng.lognormal(1.5, 1.0, n),
                   np.where(state == "in_progress", rng.exponential(3.0, n), 0.0))
    last = ts + pd.to_timedelta(lag, unit="D")
    org = np.array([AGENCY[CATS[c]] for c in c_i])
    rerouted = rng.random(n) < 0.12
    org[rerouted] = "District Office"
    df = pd.DataFrame({
        "ticket_id": [f"DEMO-{k:06d}" for k in range(n)],
        "type": [CATS[c] for c in c_i], "organization": org,
        "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S"), "last_activity": last.strftime("%Y-%m-%d %H:%M:%S"),
        "state": state, "district": [districts[d] for d in d_i], "province": "Bangkok",
    })
    df.to_csv(out / "tickets.csv", index=False)
    return out / "tickets.csv"


def main():
    print("== synthetic Offshore-Leaks-style CSVs")
    off_dir = make_offshore()
    print("== running offshore adapter")
    s1 = offshore_adapter.build(off_dir, ROOT / "data" / "offshore.json", countries="Thailand",
                                max_nodes=3500, demo=True, title="Offshore Leaks (demo data)")
    print("   ", s1)
    print("== synthetic Traffy-style tickets")
    tk = make_traffy()
    print("== running traffy adapter")
    s2 = traffy_adapter.build(tk, ROOT / "data" / "traffy.json", sample=400, demo=True,
                              title="Traffy Fondue (demo data)")
    print("   ", s2)
    manifest = [
        {"id": "offshore", "file": "data/offshore.json", "title": "Offshore Leaks",
         "blurb": "Companies, people & intermediaries"},
        {"id": "traffy", "file": "data/traffy.json", "title": "Traffy Fondue",
         "blurb": "Bangkok complaints by district"},
    ]
    (ROOT / "data" / "datasets.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("== wrote data/datasets.json")


if __name__ == "__main__":
    main()
