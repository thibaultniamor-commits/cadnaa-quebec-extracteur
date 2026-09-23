"""Session HTTP partagée (User-Agent + reprises automatiques)."""
import json
import time
import urllib.parse
import urllib.request

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

USER_AGENT = "CadnaA-Quebec-Extracteur/0.1 (+https://github.com/)"

_session = None


def session() -> requests.Session:
    global _session
    if _session is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        retry = Retry(total=3, backoff_factor=2, status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=("GET", "POST"))
        s.mount("https://", HTTPAdapter(max_retries=retry))
        _session = s
    return _session


def get_json_no_alpn(url, params, timeout=120, retries=3):
    """GET JSON via urllib (sans ALPN).

    Le pare-feu de servicescarto.mrnf.gouv.qc.ca coupe les connexions TLS qui annoncent
    uniquement « http/1.1 » en ALPN, ce que fait toujours urllib3/requests.
    """
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except OSError:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
