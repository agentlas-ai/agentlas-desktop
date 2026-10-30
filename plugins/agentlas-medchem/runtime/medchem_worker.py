"""Agentlas Medchem RDKit worker.

Reads one JSON request on stdin and writes one JSON response on stdout. Runs inside the plugin's managed Python
environment (never the Science kernel and never the owner's site-packages). No network, no file writes: drawings are
returned as bytes (base64) and the Node server decides where they may be saved.
"""

import base64
import hashlib
import json
import sys


def _fail(code, message):
    sys.stdout.write(json.dumps({"ok": False, "error": {"code": code, "message": message}}))
    sys.stdout.flush()
    sys.exit(0)


try:
    from rdkit import Chem, RDLogger, rdBase
    from rdkit.Chem import Crippen, Descriptors, Draw, FilterCatalog, Lipinski, QED, rdMolDescriptors
    from rdkit.Chem.MolStandardize import rdMolStandardize
    from rdkit.Chem import AllChem
except Exception as error:  # pragma: no cover - reported to the caller as a runtime state
    _fail("rdkit-import-failed", str(error)[:300])

RDLogger.DisableLog("rdApp.*")

_CATALOGS = {}


def _catalog(name):
    if name not in _CATALOGS:
        params = FilterCatalog.FilterCatalogParams()
        if name == "PAINS":
            params.AddCatalog(FilterCatalog.FilterCatalogParams.FilterCatalogs.PAINS)
        elif name == "BRENK":
            params.AddCatalog(FilterCatalog.FilterCatalogParams.FilterCatalogs.BRENK)
        _CATALOGS[name] = FilterCatalog.FilterCatalog(params)
    return _CATALOGS[name]


def _parse(smiles):
    if not isinstance(smiles, str) or not smiles.strip() or len(smiles) > 2000:
        return None, "smiles-invalid"
    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        return None, "smiles-unparseable"
    return mol, None


def _round(value, digits=3):
    return None if value is None else round(float(value), digits)


def _alerts(mol, name):
    return [entry.GetDescription() for entry in _catalog(name).GetMatches(mol)]


def _identity(mol):
    canonical = Chem.MolToSmiles(mol, isomericSmiles=True)
    try:
        inchi = Chem.MolToInchi(mol)
        inchikey = Chem.InchiToInchiKey(inchi) if inchi else None
    except Exception:
        inchi, inchikey = None, None
    return canonical, inchi, inchikey


def properties(molecule, include_alerts, full):
    mol, error = _parse(molecule.get("smiles"))
    name = molecule.get("name")
    if error:
        return {"name": name, "inputSmiles": molecule.get("smiles"), "error": error}
    canonical, inchi, inchikey = _identity(mol)
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    mr = Crippen.MolMR(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    hbd = rdMolDescriptors.CalcNumLipinskiHBD(mol)
    hba = rdMolDescriptors.CalcNumLipinskiHBA(mol)
    rotb = rdMolDescriptors.CalcNumRotatableBonds(mol)
    heavy = mol.GetNumHeavyAtoms()
    total_atoms = Chem.AddHs(mol).GetNumAtoms()
    qed_value = QED.qed(mol)
    lipinski_violations = sum([mw > 500, logp > 5, hbd > 5, hba > 10])
    rules = {
        "lipinskiRo5": {"violations": lipinski_violations, "pass": lipinski_violations <= 1,
                         "criteria": "MW<=500, cLogP<=5, HBD(NH+OH)<=5, HBA(N+O)<=10; pass with at most one violation"},
        "veber": {"pass": rotb <= 10 and tpsa <= 140, "criteria": "rotatable bonds<=10 and TPSA<=140"},
        "egan": {"pass": logp <= 5.88 and tpsa <= 131.6, "criteria": "cLogP<=5.88 and TPSA<=131.6"},
        "ghose": {"pass": 160 <= mw <= 480 and -0.4 <= logp <= 5.6 and 40 <= mr <= 130 and 20 <= total_atoms <= 70,
                  "criteria": "160<=MW<=480, -0.4<=cLogP<=5.6, 40<=MR<=130, 20<=atoms<=70"},
    }
    row = {
        "name": name,
        "inputSmiles": molecule.get("smiles"),
        "canonicalSmiles": canonical,
        "inchiKey": inchikey,
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "molecularWeight": _round(mw, 2),
        "exactMass": _round(Descriptors.ExactMolWt(mol), 4),
        "cLogP": _round(logp, 2),
        "tpsa": _round(tpsa, 1),
        "hbdLipinski": hbd,
        "hbaLipinski": hba,
        "hbd": Lipinski.NumHDonors(mol),
        "hba": Lipinski.NumHAcceptors(mol),
        "rotatableBonds": rotb,
        "aromaticRings": rdMolDescriptors.CalcNumAromaticRings(mol),
        "heavyAtoms": heavy,
        "fractionCsp3": _round(rdMolDescriptors.CalcFractionCSP3(mol), 3),
        "formalCharge": Chem.GetFormalCharge(mol),
        "stereocenters": len(Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)),
        "qed": _round(qed_value, 3),
        "rules": {key: {"pass": value["pass"], **({"violations": value["violations"]} if "violations" in value else {})} for key, value in rules.items()},
    }
    if include_alerts:
        pains = _alerts(mol, "PAINS")
        brenk = _alerts(mol, "BRENK")
        row["alerts"] = {"pains": pains if full else len(pains), "brenk": brenk if full else brenk[:6]}
    if full:
        row["inchi"] = inchi
        row["molarRefractivity"] = _round(mr, 2)
        row["ruleCriteria"] = {key: value["criteria"] for key, value in rules.items()}
        props = QED.properties(mol)
        row["qedProperties"] = {"MW": _round(props.MW, 2), "ALOGP": _round(props.ALOGP, 2), "HBA": props.HBA, "HBD": props.HBD,
                                "PSA": _round(props.PSA, 1), "ROTB": props.ROTB, "AROM": props.AROM, "ALERTS": props.ALERTS}
        mol2d = Chem.Mol(mol)
        AllChem.Compute2DCoords(mol2d)
        row["molfile"] = Chem.MolToMolBlock(mol2d)
    return row


def standardize(molecule, options):
    mol, error = _parse(molecule.get("smiles"))
    name = molecule.get("name")
    if error:
        return {"name": name, "inputSmiles": molecule.get("smiles"), "error": error}
    steps = []
    before = Chem.MolToSmiles(mol)
    current = rdMolStandardize.Cleanup(mol)
    if Chem.MolToSmiles(current) != before:
        steps.append("cleanup-normalize-reionize")
    if options.get("keep_largest_fragment", True):
        parent = rdMolStandardize.FragmentParent(current)
        if Chem.MolToSmiles(parent) != Chem.MolToSmiles(current):
            steps.append("largest-fragment")
        current = parent
    if options.get("neutralize", True):
        neutral = rdMolStandardize.Uncharger().uncharge(current)
        if Chem.MolToSmiles(neutral) != Chem.MolToSmiles(current):
            steps.append("neutralize")
        current = neutral
    if options.get("canonical_tautomer", False):
        tautomer = rdMolStandardize.TautomerEnumerator().Canonicalize(current)
        if Chem.MolToSmiles(tautomer) != Chem.MolToSmiles(current):
            steps.append("canonical-tautomer")
        current = tautomer
    canonical, inchi, inchikey = _identity(current)
    input_canonical = Chem.MolToSmiles(mol, isomericSmiles=True)
    return {"name": name, "inputSmiles": molecule.get("smiles"), "inputCanonicalSmiles": input_canonical,
            "standardizedSmiles": canonical, "changed": canonical != input_canonical, "steps": steps,
            "inchi": inchi, "inchiKey": inchikey, "formula": rdMolDescriptors.CalcMolFormula(current)}


def grid(molecules, options):
    mols, legends, failures = [], [], []
    for index, molecule in enumerate(molecules):
        mol, error = _parse(molecule.get("smiles"))
        if error:
            failures.append({"index": index, "name": molecule.get("name"), "error": error})
            continue
        AllChem.Compute2DCoords(mol)
        mols.append(mol)
        legends.append((molecule.get("name") or Chem.MolToSmiles(mol))[:40])
    if not mols:
        return {"error": "no-parseable-molecule", "failures": failures}
    per_row = max(1, min(8, int(options.get("mols_per_row", 4)), len(mols)))
    size = max(150, min(600, int(options.get("sub_image_size", 300))))
    svg = Draw.MolsToGridImage(mols, molsPerRow=per_row, subImgSize=(size, size), legends=legends, useSVG=True)
    png = Draw.MolsToGridImage(mols, molsPerRow=per_row, subImgSize=(size, size), legends=legends, returnPNG=True)
    if not isinstance(png, (bytes, bytearray)):
        import io
        buffer = io.BytesIO()
        png.save(buffer, format="PNG")
        png = buffer.getvalue()
    svg_bytes = svg.encode("utf-8") if isinstance(svg, str) else bytes(svg)
    return {"drawn": len(mols), "failures": failures, "molsPerRow": per_row, "subImageSize": size,
            "svgBase64": base64.b64encode(svg_bytes).decode("ascii"), "pngBase64": base64.b64encode(bytes(png)).decode("ascii"),
            "svgSha256": hashlib.sha256(svg_bytes).hexdigest(), "pngSha256": hashlib.sha256(bytes(png)).hexdigest()}


def main():
    try:
        request = json.loads(sys.stdin.read())
    except Exception:
        _fail("request-invalid", "stdin is not JSON")
    op = request.get("op")
    molecules = request.get("molecules") or []
    options = request.get("options") or {}
    versions = {"rdkit": rdBase.rdkitVersion, "python": sys.version.split()[0]}
    if op == "version":
        result = {"versions": versions}
    elif op == "properties":
        result = {"rows": [properties(m, bool(options.get("include_alerts", True)), options.get("view") == "full") for m in molecules]}
    elif op == "standardize":
        result = {"rows": [standardize(m, options) for m in molecules]}
    elif op == "grid":
        result = grid(molecules, options)
    else:
        _fail("op-invalid", "unknown op")
    result["versions"] = versions
    sys.stdout.write(json.dumps({"ok": True, "result": result}))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
