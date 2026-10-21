let itemCount = 1;
let doctorRecordId = null;
let doctorName = "";
let doctorEmail = "";
let patientRecords = [];   // full patient records, kept for Payer lookup mapping
let referringDoctorRecords = [];   // full referring doctor records (from Referring_Doctor_Report), kept for Provider Number lookup
let assistantSurgeonRecords = [];   // full records from All_Assistant_Surgeons, kept for Item_Number lookup
let healthFundOptionsCache = [];   // cached list of {ID, name} from Portal_Health_Fund_Report, used to populate each HF table row's Payer/Insurer select
let itemOptionsCache = [];   // cached list of {ID, item, description, type} from Item_Report, used by the searchable Item Number lookup
let itemsLoaded = false;     // true once every page of the Item report has been pulled in
let currentAdmissionType = 'Inpatient';

/* The Payer lookup on the Patient form is fed by the same Health Fund table,
   which also holds the three non-fund payers below. Names are matched
   case-insensitively so the IDs never need to be hard-coded. */
const SYSTEM_PAYER_NAMES = {
  medicare: "Medicare",
  dva: "Department of Veterans Affairs",
  selfPay: "Patient"
};

/* Order used to decide which payer is written to the single Payer lookup
   when more than one "Who is Paying" option is ticked. Change the order
   here if a different payer should win. */
const PAYER_PRIORITY = ['healthFund', 'medicare', 'dva', 'selfPay'];

function findPayerIdByName(name){
  if(!name) return '';
  const match = healthFundOptionsCache.find(
    o => (o.name || '').trim().toLowerCase() === name.trim().toLowerCase()
  );
  return match ? match.ID : '';
}

/* Reads the health fund row currently chosen in the "Select Health Fund /
   Work Cover" dropdown, straight from the table (no stale globals). */
function getSelectedHfRecord(){
  const hfSelect = document.getElementById('np_selectedHealthFund');
  if(!hfSelect || !hfSelect.value) return null;
  return collectHfRowsData().find(r => r.id === hfSelect.value) || null;
}

/* Returns the Payer lookup ID for whichever "Who is Paying the Invoice?"
   option is selected, following PAYER_PRIORITY when several are ticked. */
function resolveWhoIsPayingPayerId(){
  const isChecked = id => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };

  for(const key of PAYER_PRIORITY){
    if(key === 'medicare' && isChecked('np_medicareEnable')){
      return findPayerIdByName(SYSTEM_PAYER_NAMES.medicare);
    }
    if(key === 'dva' && isChecked('np_dvaEnable')){
      return findPayerIdByName(SYSTEM_PAYER_NAMES.dva);
    }
    if(key === 'healthFund' && isChecked('np_healthFundEnable')){
      const record = getSelectedHfRecord();
      if(record && record.payerId) return record.payerId;
    }
    if(key === 'selfPay' && isChecked('np_selfPayEnable')){
      return findPayerIdByName(SYSTEM_PAYER_NAMES.selfPay);
    }
  }
  return '';
}

/* ============================================================
   "WHO IS PAYING THE INVOICE?" — only one payer may be selected
   at a time. Checking any of the four options unchecks the rest,
   and hides/clears the Health Fund selector when it's turned off.
   ============================================================ */
const WHO_IS_PAYING_CHECKBOX_IDS = ['np_medicareEnable', 'np_dvaEnable', 'np_healthFundEnable', 'np_selfPayEnable'];

function enforceSinglePayerSelection(justCheckedId){
  WHO_IS_PAYING_CHECKBOX_IDS.forEach(id => {
    if(id === justCheckedId) return;
    const el = document.getElementById(id);
    if(el && el.checked) el.checked = false;
  });

  // Health Fund block only stays visible/active when it's the one selected.
  if(justCheckedId !== 'np_healthFundEnable'){
    const row = document.getElementById('hfSelectRow');
    if(row) row.style.display = 'none';
    const hfSelect = document.getElementById('np_selectedHealthFund');
    if(hfSelect) hfSelect.value = '';
    window.__selectedHfRecord = null;
  }
}

function wireSinglePayerSelection(){
  WHO_IS_PAYING_CHECKBOX_IDS.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', () => {
      if(el.checked){
        enforceSinglePayerSelection(id);
      }
      if(id === 'np_healthFundEnable'){
        togglePayerBlock('healthFund');
      }
    });
  });
}

/* ============================================================
   PAYER NUMBER FORMAT VALIDATION
   - Medicare Number: exactly 10 digits
   - IRN: exactly 1 digit
   - DVA Number: up to 9 characters, letters and/or numbers
   ============================================================ */
function wirePayerNumberValidation(){
  const medicareEl = document.getElementById('np_medicareNumber');
  if(medicareEl){
    medicareEl.setAttribute('maxlength', '10');
    medicareEl.setAttribute('inputmode', 'numeric');
    medicareEl.addEventListener('input', () => {
      medicareEl.value = medicareEl.value.replace(/\D/g, '').slice(0, 10);
    });
  }

  const irnEl = document.getElementById('np_medicareIRN');
  if(irnEl){
    irnEl.setAttribute('maxlength', '1');
    irnEl.setAttribute('inputmode', 'numeric');
    irnEl.addEventListener('input', () => {
      irnEl.value = irnEl.value.replace(/\D/g, '').slice(0, 1);
    });
  }

  const dvaEl = document.getElementById('np_dvaNumber');
  if(dvaEl){
    dvaEl.setAttribute('maxlength', '9');
    dvaEl.addEventListener('input', () => {
      dvaEl.value = dvaEl.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 9).toUpperCase();
    });
  }
}

/* ============================================================
   PAYER OPTION AVAILABILITY
   A "Who is Paying the Invoice?" option can only be selected once
   its corresponding payer details have actually been entered:
   - Medicare: requires a Medicare Number
   - DVA: requires a DVA Number
   - Health Fund / Work Cover: requires at least one completed row
     in the Health Fund / Work Cover table
   - Patient (Self Pay): only available when none of the above have
     any details entered, since self-pay implies no other payer.
   Clearing a payer's details automatically disables (and, if it was
   selected, unchecks) that option again.
   ============================================================ */
function setPayerOptionEnabled(checkboxId, wrapperId, enabled){
  const checkbox = document.getElementById(checkboxId);
  const wrapper = document.getElementById(wrapperId);
  if(!checkbox) return;

  checkbox.disabled = !enabled;
  if(wrapper) wrapper.classList.toggle('pm-payer-option-disabled', !enabled);

  if(!enabled && checkbox.checked){
    checkbox.checked = false;
    if(checkboxId === 'np_healthFundEnable'){
      togglePayerBlock('healthFund');
    } else {
      const row = document.getElementById('hfSelectRow');
      if(row) row.style.display = 'none';
    }
  }
}

function updatePayerOptionAvailability(){
  const medicareVal = (document.getElementById('np_medicareNumber').value || '').trim();
  const dvaVal = (document.getElementById('np_dvaNumber').value || '').trim();
  const hfHasRecords = collectHfRowsData().some(r => r.payerName && r.membership);

  setPayerOptionEnabled('np_medicareEnable', 'wpo-medicare', !!medicareVal);
  setPayerOptionEnabled('np_dvaEnable', 'wpo-dva', !!dvaVal);
  setPayerOptionEnabled('np_healthFundEnable', 'wpo-healthfund', hfHasRecords);

  // Patient (Self Pay) is always available, regardless of whether other
  // payer details have been entered.
  setPayerOptionEnabled('np_selfPayEnable', 'wpo-selfpay', true);
}

/* Wires the Medicare / DVA fields so typing (or clearing) them
   immediately updates which "Who is Paying" options are selectable. */
function wirePayerOptionAvailability(){
  const medicareEl = document.getElementById('np_medicareNumber');
  if(medicareEl) medicareEl.addEventListener('input', updatePayerOptionAvailability);

  const dvaEl = document.getElementById('np_dvaNumber');
  if(dvaEl) dvaEl.addEventListener('input', updatePayerOptionAvailability);

  updatePayerOptionAvailability();
}

const MEDICARE_NUMBER_REGEX = /^\d{10}$/;
const IRN_REGEX = /^\d{1}$/;
const DVA_NUMBER_REGEX = /^[a-zA-Z0-9]{1,9}$/;

async function initClaimForm() {
  try {
    const params = await ZOHO.CREATOR.UTIL.getInitParams();
    const loginEmail = params.loginUser;
    doctorEmail = loginEmail;

    const config = {
      report_name: "Doctors1",
      criteria: `(Email == "${loginEmail}")`
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Doctor fetch response:", response);

    const doctorNameEl = document.getElementById("doctorName");

    if (response.data && response.data.length > 0) {
      const record = response.data[0];

      doctorRecordId = record.ID;
      doctorName = record.Doctor_Name || "Unnamed Doctor";

      doctorNameEl.innerText = doctorName;
      await fetchHospitals();   // <-- ADD THIS: now doctorRecordId is guaranteed to be set
    } else {
      doctorNameEl.innerText = "Doctor not found";
      console.warn("No doctor record matched for:", loginEmail);
    }

  } catch (err) {
    console.error("Doctor init error:", err);
    const doctorNameEl = document.getElementById("doctorName");
    if (doctorNameEl) doctorNameEl.innerText = "Failed to load doctor";
  }
}

let currentClaimType = 'patient';

function selectClaimType(type){
  currentClaimType = type;
  const patientOpt = document.getElementById('opt-patient');
  const billingOpt = document.getElementById('opt-billing');
  const patientForm = document.getElementById('patient-subform');
  const billingForm = document.getElementById('billing-subform');
  const submitBtn = document.getElementById('submit-btn');

  if(type === 'patient'){
    patientOpt.classList.add('selected');
    billingOpt.classList.remove('selected');
    patientForm.classList.add('active');
    billingForm.classList.remove('active');
    submitBtn.classList.remove('billing-mode');
  } else {
    billingOpt.classList.add('selected');
    patientOpt.classList.remove('selected');
    billingForm.classList.add('active');
    patientForm.classList.remove('active');
    submitBtn.classList.add('billing-mode');
  }

  clearClaimError();
  requestAnimationFrame(() => {
    const activeForm = type === 'patient' ? patientForm : billingForm;
    activeForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

/* ============================================================
   CLAIM ITEMS — Item Number lookup
   The Zoho Data API returns a maximum of 200 records per call and
   hands back a record_cursor while more pages remain, so the whole
   Item report is pulled in page by page here.
   ============================================================ */
async function fetchItems() {
  try {
    itemOptionsCache = [];
    itemsLoaded = false;
    let cursor = null;

    do {
      const config = {
        report_name: "Items",
        max_records: 200
      };
      if (cursor) config.record_cursor = cursor;

      const response = await ZOHO.CREATOR.DATA.getRecords(config);

      if (response && response.data && response.data.length) {
        response.data.forEach(record => {
          itemOptionsCache.push({
            ID: record.ID,
            item: record.Item || '',
            description: record.Description || '',
            type: record.Type || ''
          });
        });
      }

      cursor = (response && response.record_cursor) ? response.record_cursor : null;
    } while (cursor);

    itemsLoaded = true;
    console.log("Total items loaded:", itemOptionsCache.length);

    // Re-render any lookup that is currently open so it picks up the new list
    document.querySelectorAll('.item-lookup').forEach(wrap => {
      const list = wrap.querySelector('.item-lookup-list');
      if(list && list.style.display === 'block'){
        openItemLookup(wrap, wrap.querySelector('.item-lookup-input').value);
      }
    });

  } catch (err) {
    console.error("Item fetch error:", err);
    itemsLoaded = true;
  }
}

/* ---- Searchable Item Number lookup (type to filter, click to pick) ---- */

function buildItemLookupHtml(){
  return `
    <div class="item-lookup">
      <input type="text" class="item-lookup-input" placeholder="-Select-" autocomplete="off">
      <input type="hidden" class="item-select">
      <div class="item-lookup-list"></div>
    </div>`;
}

/* Matches on item number first, then description. Starts-with matches
   are always ranked above contains-matches, and within each group items
   are sorted ascending (numeric-aware) so the closest / smallest match
   comes first instead of whatever order the cache happened to hold. */
function filterItems(term){
  const t = (term || '').trim().toLowerCase();
  if(!t) return itemOptionsCache.slice(0, 50);

  const starts = [];
  const contains = [];

  // Scan the whole cache (not just until 50 hits) so that "starts with"
  // matches further down the cache aren't starved out by "contains"
  // matches that happen to appear earlier.
  for(const it of itemOptionsCache){
    const code = (it.item || '').toLowerCase();
    const desc = (it.description || '').toLowerCase();
    if(code.startsWith(t)){
      starts.push(it);
    } else if(code.includes(t) || desc.includes(t)){
      contains.push(it);
    }
  }

  const sortByCode = (a, b) =>
    (a.item || '').localeCompare(b.item || '', undefined, { numeric: true, sensitivity: 'base' });

  starts.sort(sortByCode);
  contains.sort(sortByCode);

  return starts.concat(contains).slice(0, 50);
}

function escapeHtml(str){
  return (str || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function openItemLookup(wrap, term){
  const listEl = wrap.querySelector('.item-lookup-list');
  if(!listEl) return;

  if(!itemsLoaded && itemOptionsCache.length === 0){
    listEl.innerHTML = '<div class="item-lookup-empty">Loading items…</div>';
    listEl.style.display = 'block';
    return;
  }

  const results = filterItems(term);

  // Description is shown here purely for the doctor to confirm they've
  // picked the right item — only it.item (the code) is ever stored,
  // via data-id/data-label below, when an option is clicked.
  listEl.innerHTML = results.length
    ? results.map(it => `
        <div class="item-lookup-option" data-id="${it.ID}" data-label="${escapeHtml(it.item)}">
          <span class="ilo-code">${escapeHtml(it.item)}</span>
          ${it.description ? `<span class="ilo-desc">${escapeHtml(it.description)}</span>` : ''}
        </div>`).join('')
    : '<div class="item-lookup-empty">No matching items</div>';

  listEl.style.display = 'block';
}

/* Closes every lookup except the one passed in, restoring the text of any
   box the user typed in but didn't pick a valid item from. */
function closeAllItemLookups(except){
  document.querySelectorAll('.item-lookup').forEach(wrap => {
    if(wrap === except) return;
    const listEl = wrap.querySelector('.item-lookup-list');
    const hidden = wrap.querySelector('.item-select');
    const input  = wrap.querySelector('.item-lookup-input');
    if(listEl) listEl.style.display = 'none';
    if(!hidden || !input) return;

    if(!hidden.value){
      input.value = '';
    } else {
      const rec = itemOptionsCache.find(i => i.ID === hidden.value);
      if(rec) input.value = rec.item;
    }
  });
}

document.addEventListener('input', function(e){
  const input = e.target.closest('.item-lookup-input');
  if(!input) return;
  const wrap = input.closest('.item-lookup');
  wrap.querySelector('.item-select').value = '';   // typing invalidates the previous pick
  openItemLookup(wrap, input.value);
});

document.addEventListener('focusin', function(e){
  const input = e.target.closest('.item-lookup-input');
  if(!input) return;
  const wrap = input.closest('.item-lookup');
  closeAllItemLookups(wrap);
  openItemLookup(wrap, '');
});

document.addEventListener('keydown', function(e){
  if(e.key !== 'Escape') return;
  const input = e.target.closest('.item-lookup-input');
  if(input) closeAllItemLookups(null);
});

function addClaimItem(){
  itemCount++;
  const tbody = document.getElementById('claim-items-body');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${itemCount}</td>
    <td><input type="text" class="date-input" placeholder="DD/MM/YYYY" readonly autocomplete="off"></td>
    <td>${buildItemLookupHtml()}</td>
    <td><input type="text" class="comments-input" placeholder="Enter comments (optional)"></td>
    <td><button type="button" class="del-btn" onclick="removeRow(this)">🗑</button></td>
  `;
  tbody.appendChild(row);
}

function removeRow(btn){
  const tbody = document.getElementById('claim-items-body');
  if(tbody.rows.length > 1){
    btn.closest('tr').remove();
    [...tbody.rows].forEach((r,i)=> r.cells[0].textContent = i+1);
    itemCount = tbody.rows.length;
  }
}

function toggleGapAmount() {
  const enableGap = document.getElementById("enableGap");
  const gapAmount = document.getElementById("gapAmount");

  if (enableGap.checked) {
    gapAmount.disabled = false;
  } else {
    gapAmount.disabled = true;
    gapAmount.value = "";
  }
}

/* Hospitals shown here are restricted to those mapped to the logged-in
   doctor (see the Doctor_Hospital_Mappings / "My Hospitals" report),
   instead of listing every hospital in the system. Only "Active"
   mappings are shown. Adjust report_name / field API names below if
   they differ from your Creator app. */
async function fetchHospitals() {
  const hospitalSelect = document.getElementById("hospital");

  if (!doctorRecordId) {
    hospitalSelect.innerHTML = '<option value="">-Select Hospital-</option>';
    console.warn("fetchHospitals called before doctorRecordId was resolved.");
    return;
  }

  try {
    const config = {
      report_name: "Doctor_Hospital_Mappings",
      criteria: `(Doctor_Name == ${doctorRecordId} && Status == "Active")`
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Doctor-Hospital mappings fetch response:", response);

    hospitalSelect.innerHTML = '<option value="">-Select Hospital-</option>';

    if (response.data && response.data.length > 0) {
      // Dedupe in case a doctor has more than one mapping row per hospital
      const seen = new Set();

      response.data.forEach(record => {
        const hospitalLookup = record.Hospital;
        if (!hospitalLookup || !hospitalLookup.ID) return;
        if (seen.has(hospitalLookup.ID)) return;
        seen.add(hospitalLookup.ID);

        const option = document.createElement("option");
        option.value = hospitalLookup.ID;
        option.innerText = hospitalLookup.Hospital_Name || hospitalLookup.zc_display_value || hospitalLookup.display_value || "Unnamed Hospital";
        hospitalSelect.appendChild(option);
      });

      if (seen.size === 0) {
        console.warn("No hospitals mapped to this doctor.");
      }
    } else {
      console.warn("No hospital mapping records found for this doctor.");
    }

  } catch (err) {
    console.error("Hospital mapping fetch error:", err);
    hospitalSelect.innerHTML = '<option value="">Failed to load hospitals</option>';
  }
}

function updateCharCount(el){
  document.getElementById('char-count').textContent = el.value.length;
}

function toggleAsstSurgeryFields() {
  const asstSurgeryClaim = document.getElementById("asstSurgeryClaim").value;
  const primarySurgeonRow = document.getElementById("primarySurgeonRow");

  if (asstSurgeryClaim === "Yes") {
    primarySurgeonRow.style.display = "grid";
  } else {
    primarySurgeonRow.style.display = "none";
  }
}

/* Builds a display name from the Referring Doctor table's composite Name
   field (Prefix / First Name / Last Name / Suffix), skipping any parts
   that are empty. */
function buildReferringDoctorDisplayName(record){
  const nameField = record.Name || {};
  const parts = [nameField.prefix, nameField.first_name, nameField.last_name, nameField.suffix]
    .map(p => (p || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' ') : 'Unnamed Doctor';
}

/* Populates the Primary Surgeon lookup dropdown from the
   All_Assistant_Surgeons report. Selecting a surgeon auto-fills the
   Primary Surgeon Item Number field (see handlePrimarySurgeonChange). */
async function fetchAssistantSurgeons() {
  const surgeonSelect = document.getElementById("primarySurgeonName");
  if (!surgeonSelect) return;

  try {
    const config = {
      report_name: "Assistant_Surgeon_Report"
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Assistant surgeons fetch response:", response);

    surgeonSelect.innerHTML = '<option value="">-Select Primary Surgeon-</option>';

    if (response.data && response.data.length > 0) {
      assistantSurgeonRecords = response.data;

      assistantSurgeonRecords.forEach(record => {
        const option = document.createElement("option");
        option.value = record.ID;
        option.innerText = record.Name || "Unnamed Surgeon";
        surgeonSelect.appendChild(option);
      });
    } else {
      console.warn("No records found in All_Assistant_Surgeons.");
    }

  } catch (err) {
    console.error("Assistant surgeon fetch error:", err);
    surgeonSelect.innerHTML = '<option value="">Failed to load surgeons</option>';
  }
}

/* Auto-fills the Primary Surgeon Item Number when a primary surgeon
   is selected from the lookup. */
function handlePrimarySurgeonChange(){
  const select = document.getElementById('primarySurgeonName');
  const itemNumberEl = document.getElementById('primarySurgeonItemNumbers');
  if(!select || !itemNumberEl) return;

  const record = assistantSurgeonRecords.find(r => r.ID === select.value);
  itemNumberEl.value = record ? (record.Item_Number || '') : '';
}

/* Referring doctors come from the dedicated Referring Doctor Report
   (a separate table from the logged-in Doctors1/Portal_Doctors list), so
   every record returned is a valid referring doctor — no self-filtering
   needed here. The logged-in "Doctor" field (auto-filled) is untouched. */
async function fetchReferringDoctors() {
  const referringSelect = document.getElementById("referringDoctor");

  try {
    const config = {
      report_name: "Referring_Doctors"
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Referring doctors fetch response:", response);

    referringSelect.innerHTML = '<option value="">-Select Doctor-</option>';
    referringSelect.onchange = handleReferringDoctorChange;

    if (response.data && response.data.length > 0) {
      referringDoctorRecords = response.data;

      referringDoctorRecords.forEach(record => {
        const option = document.createElement("option");
        option.value = record.ID;
        option.innerText = buildReferringDoctorDisplayName(record);
        referringSelect.appendChild(option);
      });
    } else {
      console.warn("No records found in Referring Doctor Report.");
    }

  } catch (err) {
    console.error("Referring doctor fetch error:", err);
    referringSelect.innerHTML = '<option value="">Failed to load doctors</option>';
  }
}

/* Toggles between picking an existing referring doctor and typing a new one.
   (Wired to the "+ Add New Referring Doctor" button in the claim form.) */
function toggleNewReferringDoctor(){
  const select = document.getElementById('referringDoctor');
  const input = document.getElementById('referringDoctorNew');
  const btn = document.getElementById('addNewReferringDoctorBtn');
  const providerEl = document.getElementById('referringDoctorProvider');
  if(!select || !input) return;

  const addingNew = input.style.display === 'none';

  if(addingNew){
    select.style.display = 'none';
    select.value = '';
    input.style.display = 'block';
    input.value = '';
    input.focus();
    if(providerEl) providerEl.value = '';
    if(btn) btn.textContent = '↩ Choose Existing Doctor';
  } else {
    input.style.display = 'none';
    input.value = '';
    select.style.display = 'block';
    if(btn) btn.textContent = '+ Add New Referring Doctor';
  }
}

/* Auto-fills the Provider Number when an existing referring doctor is picked. */
function handleReferringDoctorChange(){
  const select = document.getElementById('referringDoctor');
  const providerEl = document.getElementById('referringDoctorProvider');
  if(!select || !providerEl) return;

  const record = referringDoctorRecords.find(r => r.ID === select.value);
  providerEl.value = record ? (record.Provider_Number || '') : '';
}

/* Creates a new record in Referring_Doctor_Report from the typed name +
   provider number, and returns its ID. */
async function createReferringDoctorRecord(fullName, providerNumber){
  const { first_name, last_name } = splitFullName(fullName);

  const config = {
    form_name: "Referring_Doctor",   // <-- set this to your actual form link name for Referring_Doctor_Report
    payload: {
      data: {
        Name: {
          first_name: first_name,
          last_name: last_name
        },
        Provider_Number: providerNumber || ''
      }
    }
  };

  const response = await ZOHO.CREATOR.DATA.addRecords(config);
  console.log("Create referring doctor response:", response);

  if(response && response.code === 3000 && response.data && response.data.ID){
    return response.data.ID;
  }
  throw new Error("Failed to create referring doctor record");
}

/* Resolves which Referring_Doctor ID to send with the claim: creates a new
   record if the user is in "add new" mode and typed a name, otherwise
   returns whatever is picked in the dropdown. */
async function resolveReferringDoctorId(){
  const newInput = document.getElementById('referringDoctorNew');
  const select = document.getElementById('referringDoctor');
  const providerEl = document.getElementById('referringDoctorProvider');

  const isAddingNew = newInput && newInput.style.display !== 'none';

  if(isAddingNew && newInput.value.trim()){
    const newId = await createReferringDoctorRecord(newInput.value.trim(), providerEl ? providerEl.value.trim() : '');
    await fetchReferringDoctors();   // refresh cache/dropdown so it's available next time
    return newId;
  }

  return select ? select.value : '';
}

async function fetchPatients(selectIdAfterLoad) {
  const patientSelect = document.getElementById("patient");

  try {
    const config = {
      report_name: "My_Patients"
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Patients fetch response:", response);

    patientSelect.innerHTML = '<option value="">-Select Patient-</option>';

    if (response.data && response.data.length > 0) {
      patientRecords = response.data;

      patientRecords.forEach(record => {
        const option = document.createElement("option");
        option.value = record.ID;
        option.innerText = record.Patient_Name.first_name + " " + record.Patient_Name.last_name || "Unnamed Patient";
        patientSelect.appendChild(option);
      });
    } else {
      console.warn("No patient records found.");
    }

    if (selectIdAfterLoad) {
      patientSelect.value = selectIdAfterLoad;
      handlePatientChange();
    }

  } catch (err) {
    console.error("Patient fetch error:", err);
    patientSelect.innerHTML = '<option value="">Failed to load patients</option>';
  }
}

async function fetchHealthFunds() {
  const payerSelect = document.getElementById("payer");

  try {
    const config = {
      report_name: "Portal_Health_Fund_Report"
    };

    const response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("Health funds fetch response:", response);

    payerSelect.innerHTML = '<option value="">-Select Payer-</option>';
    healthFundOptionsCache = [];

    if (response.data && response.data.length > 0) {
      response.data.forEach(record => {
        const option = document.createElement("option");
        option.value = record.ID;
        option.innerText = record.Health_Fund_Name || "Unnamed Health Fund";
        payerSelect.appendChild(option);

        healthFundOptionsCache.push({ ID: record.ID, name: option.innerText });
      });
    } else {
      console.warn("No health fund records found.");
    }

    // Refresh the Payer/Insurer Name select in any HF table rows already on screen
    refreshHfRowPayerOptions();

  } catch (err) {
    console.error("Health fund fetch error:", err);
    payerSelect.innerHTML = '<option value="">Failed to load payers</option>';
  }
}

function handlePatientChange() {
  const patientSelect = document.getElementById("patient");
  const payerSelect = document.getElementById("payer");
  const payerDisplayEl = document.getElementById("payerDisplayValue");
  const membershipDisplayEl = document.getElementById("membershipDisplayValue");
  const editPatientBtn = document.getElementById("editPatientBtn");
  const selectedId = patientSelect.value;

  if (!selectedId) {
    payerSelect.value = "";
    if (payerDisplayEl) payerDisplayEl.textContent = "Select a patient to view payer details";
    if (membershipDisplayEl) membershipDisplayEl.textContent = "-";
    if (editPatientBtn) editPatientBtn.disabled = true;
    return;
  }

  const patient = patientRecords.find(p => p.ID === selectedId);
  if (!patient) return;

  if (editPatientBtn) editPatientBtn.disabled = false;

  // Membership Number lives directly on the patient record.
  if (membershipDisplayEl) {
    membershipDisplayEl.textContent = patient.Membership_Number ? patient.Membership_Number : "-";
  }

  const payerLookup = patient.Payer;

  if (payerLookup && payerLookup.ID) {
    const matchedOption = [...payerSelect.options].find(
      opt => opt.value === payerLookup.ID
    );

    if (matchedOption) {
      payerSelect.value = payerLookup.ID;
      if (payerDisplayEl) payerDisplayEl.textContent = matchedOption.textContent;
    } else {
      console.warn("Payer ID from patient record not found in Payer dropdown:", payerLookup);
      if (payerDisplayEl) {
        payerDisplayEl.textContent = payerLookup.zc_display_value || payerLookup.display_value || "-";
      }
    }
  } else {
    payerSelect.value = "";
    if (payerDisplayEl) payerDisplayEl.textContent = "-";
    console.warn("Patient has no Payer set:", patient);
  }

  clearFieldInvalid(patientSelect);
  clearClaimError();
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let calendarActiveInput = null;
let calendarViewDate = new Date();

function pad2(n){ return n < 10 ? "0" + n : "" + n; }

function formatDisplayDate(d){
  const day = pad2(d.getDate());
  const month = MONTH_NAMES[d.getMonth()].slice(0,3);
  return `${day}-${month}-${d.getFullYear()}`;
}

function buildCalendarPopup(){
  if(document.getElementById('dateCalendarPopup')) return;
  const popup = document.createElement('div');
  popup.id = 'dateCalendarPopup';
  popup.className = 'calendar-popup';
  popup.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="calPrev">‹</button>
      <div class="cal-title" id="calTitle"></div>
      <button type="button" class="cal-nav" id="calNext">›</button>
    </div>
    <div class="cal-weekdays">
      <span>SU</span><span>MO</span><span>TU</span><span>WE</span><span>TH</span><span>FR</span><span>SA</span>
    </div>
    <div class="cal-days" id="calDays"></div>
    <div class="cal-footer">
      <button type="button" class="cal-clear" id="calClear">Clear</button>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById('calClear').addEventListener('click', (e)=>{
    e.stopPropagation();
    if(calendarActiveInput){
      calendarActiveInput.value = '';
    }
    closeCalendar();
  });

  document.getElementById('calPrev').addEventListener('click', (e)=>{
    e.stopPropagation();
    calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', (e)=>{
    e.stopPropagation();
    calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
    renderCalendar();
  });
  popup.addEventListener('click', (e)=> e.stopPropagation());
}

function renderCalendar(){
  const popup = document.getElementById('dateCalendarPopup');
  if(!popup) return;

  const today = new Date();
  today.setHours(0,0,0,0);

  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();

  document.getElementById('calTitle').textContent = `${MONTH_NAMES[month]} ${year}`;

  const nextBtn = document.getElementById('calNext');
  const isCurrentMonth = (year === today.getFullYear() && month === today.getMonth());
  nextBtn.disabled = isCurrentMonth;

  const daysContainer = document.getElementById('calDays');
  daysContainer.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for(let i = 0; i < firstDay; i++){
    const empty = document.createElement('span');
    empty.className = 'cal-day empty';
    daysContainer.appendChild(empty);
  }

  for(let d = 1; d <= daysInMonth; d++){
    const cellDate = new Date(year, month, d);
    cellDate.setHours(0,0,0,0);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = d;

    const isFuture = cellDate.getTime() > today.getTime();
    const isToday = cellDate.getTime() === today.getTime();

    if(isFuture){
      btn.disabled = true;
      btn.classList.add('disabled');
    } else {
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        if(calendarActiveInput){
          calendarActiveInput.value = formatDisplayDate(cellDate);
          clearFieldInvalid(calendarActiveInput);
          clearClaimError();
        }
        closeCalendar();
      });
    }
    if(isToday) btn.classList.add('today');

    daysContainer.appendChild(btn);
  }
}

function openCalendar(input){
  buildCalendarPopup();
  calendarActiveInput = input;
  calendarViewDate = new Date();
  renderCalendar();

  const popup = document.getElementById('dateCalendarPopup');
  popup.style.display = 'block';

  const rect = input.getBoundingClientRect();
  popup.style.top = (window.scrollY + rect.bottom + 6) + 'px';
  popup.style.left = (window.scrollX + rect.left) + 'px';
}

function closeCalendar(){
  const popup = document.getElementById('dateCalendarPopup');
  if(popup) popup.style.display = 'none';
  calendarActiveInput = null;
}

/* Single global click handler: date picker, item lookup selection, and
   closing whichever popup the click landed outside of. */
document.addEventListener('click', function(e){
  // --- Item lookup option chosen ---
  const opt = e.target.closest('.item-lookup-option');
  if(opt){
    const wrap = opt.closest('.item-lookup');
    wrap.querySelector('.item-select').value = opt.dataset.id;
    wrap.querySelector('.item-lookup-input').value = opt.dataset.label;
    wrap.querySelector('.item-lookup-list').style.display = 'none';
    clearFieldInvalid(wrap.querySelector('.item-lookup-input'));
    clearClaimError();
    closeCalendar();
    return;
  }

  // --- Clicks outside any item lookup close them all ---
  const insideLookup = e.target.closest('.item-lookup');
  closeAllItemLookups(insideLookup || null);

  // --- Date picker ---
  const input = e.target.closest('.date-input');
  if(input){
    openCalendar(input);
  } else if(!e.target.closest('#dateCalendarPopup')){
    closeCalendar();
  }
});

function wireDropzone(dropzoneId, browseLinkId, fileInputId, fileListId){
  const dropzone = document.getElementById(dropzoneId);
  const browseLink = document.getElementById(browseLinkId);
  const fileInput = document.getElementById(fileInputId);
  const fileList = document.getElementById(fileListId);

  if(!dropzone || !browseLink || !fileInput) return;

  function renderFiles(files){
    if(!fileList) return;
    fileList.innerHTML = '';
    [...files].forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.textContent = `📄 ${f.name}`;
      fileList.appendChild(item);
    });
  }

  browseLink.addEventListener('click', (e)=>{
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', (e)=>{
    if(e.target === browseLink) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', ()=>{
    renderFiles(fileInput.files);
  });

  dropzone.addEventListener('dragover', (e)=>{
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', ()=>{
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e)=>{
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if(e.dataTransfer.files.length){
      fileInput.files = e.dataTransfer.files;
      renderFiles(fileInput.files);
    }
  });
}

let editingPatientId = null; // null = creating a new patient, otherwise the ID being edited

function openAddPatientModal(){
  const modal = document.getElementById('addPatientModal');
  if(!modal) return;
  editingPatientId = null;
  resetAddPatientForm();
  setPatientModalMode('create');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

/* ============================================================
   EDIT PATIENT — reuses the "Add New Patient" modal, prefilled
   with the currently selected patient's data. Saving calls
   updateRecordById instead of addRecords.
   ============================================================ */
function openEditPatientModal(){
  const patientSelect = document.getElementById('patient');
  const selectedId = patientSelect ? patientSelect.value : '';
  if(!selectedId) return;

  const patient = patientRecords.find(p => p.ID === selectedId);
  if(!patient) return;

  const modal = document.getElementById('addPatientModal');
  if(!modal) return;

  editingPatientId = selectedId;
  resetAddPatientForm();
  prefillPatientForm(patient);
  setPatientModalMode('edit');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function setPatientModalMode(mode){
  const titleEl = document.getElementById('pmTitleText');
  const subtitleEl = document.getElementById('pmSubtitleText');
  // The header Save button is optional (it isn't present in every layout),
  // so each element is updated only if it exists.
  const headerSaveText = document.getElementById('pmHeaderSaveText');
  const footerSaveText = document.getElementById('pmFooterSaveText');
  if(!titleEl) return;

  const isEdit = mode === 'edit';
  const saveLabel = isEdit ? 'Update Patient' : 'Save Patient';

  titleEl.textContent = isEdit ? 'Edit Patient' : 'Create New Patient';
  if(subtitleEl){
    subtitleEl.textContent = isEdit
      ? 'Update patient details and payer information. All mandatory fields must be completed.'
      : 'Enter patient details and payer information. All mandatory fields must be completed.';
  }
  if(headerSaveText) headerSaveText.textContent = saveLabel;
  if(footerSaveText) footerSaveText.textContent = saveLabel;
}

/* Sets a <select> value, adding the option first if the stored value
   isn't one of the predefined choices (so editing never loses data). */
function setSelectValueSafe(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  if(!val){ el.value = ''; return; }
  const exists = [...el.options].some(o => o.value === val);
  if(!exists){
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    el.appendChild(opt);
  }
  el.value = val;
}

function prefillPatientForm(patient){
  const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val || ''; };

  setVal('np_firstName', patient.Patient_Name ? patient.Patient_Name.first_name : '');
  setVal('np_lastName', patient.Patient_Name ? patient.Patient_Name.last_name : '');
  setVal('np_dob', zohoDateToIso(patient.date_of_birth));
  calculateNewPatientAge();
  setSelectValueSafe('np_gender', patient.gender);
  setVal('np_email', patient.email);
  setVal('np_phone', patient.Mobile);

  if(patient.address){
    setVal('np_address1', patient.address.address_line_1);
    setVal('np_address2', patient.address.address_line_2);
    setVal('np_city', patient.address.district_city);
    setSelectValueSafe('np_state', patient.address.state_province);
    setVal('np_postcode', patient.address.postal_code);
    setSelectValueSafe('np_country', patient.address.country || 'Australia');
  }

  if((patient.Medicare || '').trim()){
    document.getElementById('np_medicareEnable').checked = true;
    setVal('np_medicareNumber', patient.Medicare);
  }
  if(patient.Individual_Reference_Number){
    setVal('np_medicareIRN', patient.Individual_Reference_Number);
  }

  if((patient.Veteran_Affairs || '').trim()){
    document.getElementById('np_dvaEnable').checked = true;
    setVal('np_dvaNumber', patient.Veteran_Affairs);
  }

  // Existing single Payer / Fund / Membership on the patient record becomes
  // one row in the Health Fund / Work Cover table, pre-selected as the payer.
  // Zoho returns an empty object {} for unset lookup fields and "" for empty
  // text, so check for real values before treating a health fund as present.
  const payerId = (patient.Payer && patient.Payer.ID) ? patient.Payer.ID : '';
  const fundLookupId = (patient.Health_Fund_Work_cover_Name && patient.Health_Fund_Work_cover_Name.ID)
    ? patient.Health_Fund_Work_cover_Name.ID : '';
  const membershipNo = (patient.Membership_Number || '').trim();

  if(payerId || fundLookupId || membershipNo){
    const fundId = fundLookupId || payerId;
    const payerName = healthFundOptionsCache.find(o => o.ID === payerId);

    const rowId = addHfTableRow({
      type: 'Health Fund',
      payerId: payerId,
      payerName: payerName ? payerName.name : (patient.Payer ? (patient.Payer.zc_display_value || patient.Payer.display_value || '') : ''),
      fundId: fundId,
      membership: membershipNo,
      additional: ''
    });

    document.getElementById('np_healthFundEnable').checked = true;
    enforceSinglePayerSelection('np_healthFundEnable');
    togglePayerBlock('healthFund');
    syncHfSelectOptions();
    document.getElementById('np_selectedHealthFund').value = rowId;
    applySelectedHealthFund();
  }

  // Tick the matching "Who is Paying the Invoice?" card based on the
  // Payer lookup stored against the patient.
  if(payerId && !document.getElementById('np_healthFundEnable').checked){
    const medicareId = findPayerIdByName(SYSTEM_PAYER_NAMES.medicare);
    const dvaId = findPayerIdByName(SYSTEM_PAYER_NAMES.dva);
    const selfPayId = findPayerIdByName(SYSTEM_PAYER_NAMES.selfPay);

    if(payerId === medicareId){
      document.getElementById('np_medicareEnable').checked = true;
      enforceSinglePayerSelection('np_medicareEnable');
    } else if(payerId === dvaId){
      document.getElementById('np_dvaEnable').checked = true;
      enforceSinglePayerSelection('np_dvaEnable');
    } else if(payerId === selfPayId){
      document.getElementById('np_selfPayEnable').checked = true;
      enforceSinglePayerSelection('np_selfPayEnable');
    }
  }

  updatePayerOptionAvailability();
}

/* Converts a Zoho "DD-MMM-YYYY" date string back into "YYYY-MM-DD"
   for the native <input type="date"> field. Returns '' if invalid. */
function zohoDateToIso(zohoDateStr){
  if(!zohoDateStr) return '';
  const parts = zohoDateStr.split('-');
  if(parts.length !== 3) return '';
  const [day, monStr, year] = parts;
  const monthIdx = MONTH_NAMES.findIndex(m => m.slice(0,3).toLowerCase() === monStr.toLowerCase());
  if(monthIdx < 0) return '';
  return `${year}-${pad2(monthIdx + 1)}-${pad2(parseInt(day,10))}`;
}

function closeAddPatientModal(){
  const modal = document.getElementById('addPatientModal');
  if(!modal) return;
  modal.classList.remove('active');
  document.body.style.overflow = '';
  editingPatientId = null;
}

document.addEventListener('keydown', function(e){
  if(e.key === 'Escape'){
    const overlay = document.getElementById('addPatientModal');
    if(overlay && overlay.classList.contains('active')){
      closeAddPatientModal();
    }
  }
});

function resetAddPatientForm(){
  const ids = [
    'np_firstName','np_lastName','np_dob','np_gender','np_email','np_phone',
    'np_address1','np_address2','np_city','np_state','np_postcode',
    'np_medicareNumber','np_medicareIRN','np_dvaNumber'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.value = '';
  });
  document.getElementById('np_country').value = 'Australia';

  ['np_medicareEnable','np_healthFundEnable','np_dvaEnable','np_selfPayEnable'].forEach(id => {
    const cb = document.getElementById(id);
    if(cb) cb.checked = false;
  });
  togglePayerBlock('healthFund');

  // Clear the inline Health Fund / Work Cover table
  const tbody = document.getElementById('hfRecordsTable');
  if(tbody){
    tbody.innerHTML = '<tr id="hfEmptyRow"><td colspan="5" class="hf-empty">No Health Fund / Work Cover records added yet.</td></tr>';
  }
  hfRowCounter = 0;
  const hfSelect = document.getElementById('np_selectedHealthFund');
  if(hfSelect) hfSelect.innerHTML = '<option value="">-Select Health Fund / Work Cover-</option>';

  const err = document.getElementById('pmError');
  if(err){ err.style.display = 'none'; err.textContent = ''; }

  updatePayerOptionAvailability();
}

/* The redesigned layout no longer shows an Age field (age is derived
   from Date of Birth), so every element lookup here is guarded. */
function computeAgeFromIso(isoDateStr){
  if(!isoDateStr) return '';
  const dob = new Date(isoDateStr);
  if(isNaN(dob.getTime())) return '';
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if(m < 0 || (m === 0 && today.getDate() < dob.getDate())){
    age--;
  }
  return age >= 0 ? String(age) : '';
}

function calculateNewPatientAge(){
  const dobEl = document.getElementById('np_dob');
  const ageEl = document.getElementById('np_age');   // may not exist in the new layout
  if(!ageEl) return;
  ageEl.value = dobEl && dobEl.value ? computeAgeFromIso(dobEl.value) + ' yrs' : '';
}

function formatDateForZoho(isoDateStr){
  if(!isoDateStr) return '';
  const parts = isoDateStr.split('-');
  if(parts.length !== 3) return '';
  const [year, month, day] = parts;
  const monthIdx = parseInt(month, 10) - 1;
  if(monthIdx < 0 || monthIdx > 11) return '';
  return `${pad2(parseInt(day,10))}-${MONTH_NAMES[monthIdx].slice(0,3)}-${year}`;
}

/* ============================================================
   HEALTH FUND / WORK COVER RECORDS TABLE
   Inline-editable — no popup. Rows are added directly into the
   table and the user types values straight into the row.
   ============================================================ */
let hfRowCounter = 0;

/* Real health funds / insurers only — the Medicare, DVA and Patient rows in
   the Health Fund table are payer types, not funds, so they are excluded
   from the Health Fund / Work Cover row dropdowns. */
function getSelectableFundOptions(){
  const excluded = Object.values(SYSTEM_PAYER_NAMES).map(n => n.toLowerCase());
  return healthFundOptionsCache.filter(
    o => !excluded.includes((o.name || '').trim().toLowerCase())
  );
}

function refreshHfRowPayerOptions(){
  document.querySelectorAll('.hf-payer-select').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = '<option value="">-Select Payer / Insurer-</option>' +
      getSelectableFundOptions().map(item => `<option value="${item.ID}">${item.name}</option>`).join('');
    if(current) sel.value = current;
  });
}

/* Adds a new editable row. Optionally pre-filled (used when prefilling
   an existing patient for editing). Returns the row's internal id. */
function addHfTableRow(prefill){
  const tbody = document.getElementById('hfRecordsTable');
  const emptyRow = document.getElementById('hfEmptyRow');
  if(emptyRow) emptyRow.remove();

  hfRowCounter++;
  const rowId = 'hfrow_' + hfRowCounter;

  const payerOptionsHtml = '<option value="">-Select Payer / Insurer-</option>' +
    getSelectableFundOptions().map(item => `<option value="${item.ID}">${item.name}</option>`).join('');

  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td>
      <select class="hf-payer-select" onchange="syncHfSelectOptions()">${payerOptionsHtml}</select>
    </td>
    <td>
      <select class="hf-type-select" onchange="syncHfSelectOptions()">
        <option value="Health Fund">Health Fund</option>
        <option value="Work Cover">Work Cover</option>
      </select>
    </td>
    <td>
      <input type="text" class="hf-membership-input" placeholder="Enter membership / claim no." oninput="syncHfSelectOptions()">
    </td>
    <td>
      <input type="text" class="hf-additional-input" placeholder="e.g. Hospital & Extras" oninput="syncHfSelectOptions()">
    </td>
    <td>
      <button type="button" class="hf-action-btn delete" onclick="removeHfTableRow('${rowId}')" title="Remove">🗑</button>
    </td>
  `;
  tbody.appendChild(tr);

  if(prefill){
    const payerSel = tr.querySelector('.hf-payer-select');
    const typeSel = tr.querySelector('.hf-type-select');
    const membershipInput = tr.querySelector('.hf-membership-input');
    const additionalInput = tr.querySelector('.hf-additional-input');
    if(payerSel && prefill.payerId) payerSel.value = prefill.payerId;
    if(typeSel && prefill.type) typeSel.value = prefill.type;
    if(membershipInput) membershipInput.value = prefill.membership || '';
    if(additionalInput) additionalInput.value = prefill.additional || '';
  }

  syncHfSelectOptions();
  return rowId;
}

function removeHfTableRow(rowId){
  const row = document.getElementById(rowId);
  if(row) row.remove();

  const tbody = document.getElementById('hfRecordsTable');
  if(tbody && tbody.children.length === 0){
    tbody.innerHTML = '<tr id="hfEmptyRow"><td colspan="5" class="hf-empty">No Health Fund / Work Cover records added yet.</td></tr>';
  }

  const hfSelect = document.getElementById('np_selectedHealthFund');
  if(hfSelect && hfSelect.value === rowId){
    hfSelect.value = '';
    applySelectedHealthFund();
  }

  syncHfSelectOptions();
}

/* Reads every row currently in the Health Fund / Work Cover table and
   returns them as plain records. */
function collectHfRowsData(){
  const rows = document.querySelectorAll('#hfRecordsTable tr');
  const records = [];
  rows.forEach(row => {
    if(row.id === 'hfEmptyRow') return;
    const payerSel = row.querySelector('.hf-payer-select');
    const typeSel = row.querySelector('.hf-type-select');
    const membershipInput = row.querySelector('.hf-membership-input');
    const additionalInput = row.querySelector('.hf-additional-input');
    if(!payerSel) return;

    records.push({
      id: row.id,
      type: typeSel ? typeSel.value : 'Health Fund',
      payerId: payerSel.value,
      payerName: payerSel.options[payerSel.selectedIndex] ? payerSel.options[payerSel.selectedIndex].textContent : '',
      fundId: payerSel.value,
      membership: membershipInput ? membershipInput.value.trim() : '',
      additional: additionalInput ? additionalInput.value.trim() : ''
    });
  });
  return records;
}

/* Keeps the "Select Health Fund / Work Cover" dropdown in sync with
   whatever is currently typed into the Health Fund / Work Cover table. */
function syncHfSelectOptions(){
  const hfSelect = document.getElementById('np_selectedHealthFund');
  if(!hfSelect) return;

  const records = collectHfRowsData();
  const previousValue = hfSelect.value;

  hfSelect.innerHTML = '<option value="">-Select Health Fund / Work Cover-</option>' +
    records
      .filter(r => r.payerName && r.membership)
      .map(r => `<option value="${r.id}">${r.payerName} – Membership No. ${r.membership}</option>`)
      .join('');

  if(records.some(r => r.id === previousValue)){
    hfSelect.value = previousValue;
  }

  applySelectedHealthFund();
  updatePayerOptionAvailability();
}

function applySelectedHealthFund(){
  window.__selectedHfRecord = getSelectedHfRecord();
}

function splitFullName(fullName){
  if(!fullName) return { first_name: '', last_name: '' };
  const parts = fullName.trim().split(/\s+/);
  return {
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' ') || ''
  };
}

function togglePayerBlock(type){
  if(type === 'healthFund'){
    const enabled = document.getElementById('np_healthFundEnable').checked;
    const row = document.getElementById('hfSelectRow');
    if(row) row.style.display = enabled ? 'block' : 'none';
    if(enabled){
      syncHfSelectOptions();
    } else {
      document.getElementById('np_selectedHealthFund').value = '';
      window.__selectedHfRecord = null;
    }
  }
  // Medicare and DVA number fields are always editable; their
  // checkboxes in "Who is Paying" only control whether that payer
  // is included when the patient is saved (see buildNewPatientPayload).
}

function showPatientModalError(message){
  const err = document.getElementById('pmError');
  if(!err) return;
  err.textContent = message;
  err.style.display = 'block';
}

function buildNewPatientPayload(){
  const data = {
    Patient_Name: {
      first_name: document.getElementById('np_firstName').value.trim(),
      last_name: document.getElementById('np_lastName').value.trim()
    },
    date_of_birth: formatDateForZoho(document.getElementById('np_dob').value),
    gender: document.getElementById('np_gender').value || '',
    email: document.getElementById('np_email').value.trim(),
    Mobile: document.getElementById('np_phone').value.trim(),
    address: {
      address_line_1: document.getElementById('np_address1').value.trim(),
      address_line_2: document.getElementById('np_address2').value.trim(),
      district_city: document.getElementById('np_city').value.trim(),
      state_province: document.getElementById('np_state').value.trim(),
      postal_code: document.getElementById('np_postcode').value.trim(),
      country: document.getElementById('np_country').value.trim() || 'Australia'
    },
    Patient_Age: computeAgeFromIso(document.getElementById('np_dob').value)
  };

  data.Medicare = document.getElementById('np_medicareEnable').checked
    ? document.getElementById('np_medicareNumber').value.trim()
    : '';
  // Zoho field is "Individual_Reference_Number" (not "IRN")
  data.Individual_Reference_Number = document.getElementById('np_medicareEnable').checked
    ? (document.getElementById('np_medicareIRN').value || '').trim()
    : '';

  data.Veteran_Affairs = document.getElementById('np_dvaEnable').checked
    ? document.getElementById('np_dvaNumber').value.trim()
    : '';

  // When Health Fund / Work Cover is the payer, copy the selected row into
  // the patient's Health Fund / Work cover Name, Membership Number, Type and
  // Additional Details fields.
  const selectedHf = document.getElementById('np_healthFundEnable').checked
    ? getSelectedHfRecord()
    : null;

  data.Membership_Number = selectedHf ? (selectedHf.membership || '') : '';
  data.Type = selectedHf ? (selectedHf.type || '') : '';
  data.Additional_Details = selectedHf ? (selectedHf.additional || '') : '';

  // Lookup fields: Zoho rejects an empty string for a lookup, so only send
  // Payer / Health Fund when a real record ID has been resolved.
  const fundLookupId = selectedHf ? (selectedHf.fundId || '') : '';
  if(fundLookupId){
    data.Health_Fund_Work_cover_Name = fundLookupId;
  }

  // "Who is Paying the Invoice?" drives the Payer lookup on the patient record
  const payerLookupId = resolveWhoIsPayingPayerId();
  if(payerLookupId){
    data.Payer = payerLookupId;
  }

  return data;
}

async function handleCreateNewPatient(){
  const err = document.getElementById('pmError');
  if(err){ err.style.display = 'none'; err.textContent = ''; }

  const firstName = document.getElementById('np_firstName').value.trim();
  const lastName = document.getElementById('np_lastName').value.trim();
  const phone = document.getElementById('np_phone').value.trim();
  const dob = document.getElementById('np_dob').value;
  const address1 = document.getElementById('np_address1').value.trim();
  const city = document.getElementById('np_city').value.trim();
  const state = document.getElementById('np_state').value;
  const postcode = document.getElementById('np_postcode').value.trim();

  if(!firstName || !lastName){
    showPatientModalError('First Name and Last Name are required.');
    return;
  }
  if(!phone){
    showPatientModalError('Phone Number is required.');
    return;
  }
  if(!dob){
    showPatientModalError('Date of Birth is required.');
    return;
  }
  if(!address1){
    showPatientModalError('Address Line 1 is required.');
    return;
  }
  if(!city){
    showPatientModalError('Suburb / City is required.');
    return;
  }
  if(!state){
    showPatientModalError('State / Territory is required.');
    return;
  }
  if(!postcode){
    showPatientModalError('Postcode is required.');
    return;
  }

  // Payer number format checks
  if(document.getElementById('np_medicareEnable').checked){
    const medicareVal = document.getElementById('np_medicareNumber').value.trim();
    if(!MEDICARE_NUMBER_REGEX.test(medicareVal)){
      showPatientModalError('Medicare Number must be exactly 10 digits.');
      return;
    }
    const irnVal = (document.getElementById('np_medicareIRN').value || '').trim();
    if(irnVal && !IRN_REGEX.test(irnVal)){
      showPatientModalError('IRN (Individual Reference Number) must be exactly 1 digit.');
      return;
    }
  }
  if(document.getElementById('np_dvaEnable').checked){
    const dvaVal = document.getElementById('np_dvaNumber').value.trim();
    if(!DVA_NUMBER_REGEX.test(dvaVal)){
      showPatientModalError('DVA Number must be 1-9 characters (letters and/or numbers).');
      return;
    }
  }

  // Only one payer may be selected at a time
  const payerCheckCount = WHO_IS_PAYING_CHECKBOX_IDS.filter(id => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  }).length;
  if(payerCheckCount > 1){
    showPatientModalError('Please select only one payer for "Who is Paying the Invoice?".');
    return;
  }

  if(document.getElementById('np_healthFundEnable').checked && !document.getElementById('np_selectedHealthFund').value){
    showPatientModalError('Please select a Health Fund / Work Cover record, or add one to the table first.');
    return;
  }

  const headerBtn = document.getElementById('pmHeaderSaveBtn');
  const footerBtn = document.getElementById('pmCreateBtn');
  const headerText = document.getElementById('pmHeaderSaveText');
  const footerText = document.getElementById('pmFooterSaveText');
  const originalHeaderText = headerText ? headerText.textContent : '';
  const originalFooterText = footerText ? footerText.textContent : '';

  [headerBtn, footerBtn].forEach(b => { if(b) b.disabled = true; });
  if(headerText) headerText.textContent = editingPatientId ? 'Updating...' : 'Creating...';
  if(footerText) footerText.textContent = editingPatientId ? 'Updating...' : 'Creating...';

  try {
    const payload = buildNewPatientPayload();

    if(editingPatientId){
      // Single-record update: ZOHO.CREATOR.DATA.updateRecordById takes the
      // record ID directly. (updateRecords is the bulk call and requires a
      // criteria instead — that mismatch caused error 3090.)
      const updateConfig = {
        report_name: "Portal_Patients",   // change if your portal-permitted report has a different name
        id: editingPatientId,
        payload: {
          data: payload
        }
      };

      const response = await ZOHO.CREATOR.DATA.updateRecordById(updateConfig);
      console.log("Update patient response:", response);

      if(response && response.code === 3000){
        const updatedId = editingPatientId;
        closeAddPatientModal();
        await fetchPatients(updatedId);   // refreshes the list and re-triggers the Payer/Membership display
      } else {
        console.error("Unexpected response updating patient:", response);
        showPatientModalError('Something went wrong while updating the patient. Please try again.');
      }
    } else {
      const config = {
        form_name: "Add_Patient",
        payload: {
          data: payload
        }
      };

      const response = await ZOHO.CREATOR.DATA.addRecords(config);
      console.log("Create patient response:", response);

      if(response && response.code === 3000){
        const newRecordId = response.data && response.data.ID;

        closeAddPatientModal();

        await fetchPatients(newRecordId);
      } else {
        console.error("Unexpected response creating patient:", response);
        showPatientModalError('Something went wrong while creating the patient. Please try again.');
      }
    }

  } catch (err2) {
    console.error("Save patient error:", err2);
    // status 0 / "Failed to fetch" means the request never reached Zoho
    // (network drop, timeout, or blocked request) rather than a data problem.
    const isNetworkError = err2 && (err2.status === 0 || /failed to fetch/i.test(err2.statusText || err2.message || ''));
    if(isNetworkError){
      showPatientModalError('Could not reach the server. Check your connection and try again — your details have been kept on this form.');
    } else {
      showPatientModalError(editingPatientId ? 'Failed to update the patient. Please try again.' : 'Failed to create the patient. Please try again.');
    }
  } finally {
    [headerBtn, footerBtn].forEach(b => { if(b) b.disabled = false; });
    if(headerText) headerText.textContent = originalHeaderText;
    if(footerText) footerText.textContent = originalFooterText;
  }
}

function collectClaimItems(){
  const rows = document.querySelectorAll('#claim-items-body tr');
  const items = [];
  rows.forEach(row => {
    const dateInput = row.querySelector('.date-input');
    const itemHidden = row.querySelector('.item-select');   // hidden input holding the lookup ID
    const commentsInput = row.querySelector('.comments-input');

    const dateOfService = dateInput ? dateInput.value : '';
    const itemId = itemHidden ? itemHidden.value : '';
    const comments = commentsInput ? commentsInput.value : '';

    if(dateOfService || itemId || comments){
      items.push({
        Date_of_Service: dateOfService,
        Item_No: itemId,
        Comments: comments
      });
    }
  });
  return items;
}

/* ============================================================
   MANDATORY FIELD VALIDATION — required only when Submitting
   (not when Saving as Draft). Checks:
     - Hospital
     - Patient (Patient Claim type only)
     - Date of Service (every claim item row, Patient Claim type only)
     - Item Number (every claim item row, Patient Claim type only)
   Highlights the first missing field, shows a message above the
   action buttons, and cancels the submit.
   ============================================================ */
function showClaimError(message){
  const err = document.getElementById('claimError');
  if(!err) return;
  err.textContent = message;
  err.style.display = 'flex';
}

function clearClaimError(){
  const err = document.getElementById('claimError');
  if(!err) return;
  err.style.display = 'none';
  err.textContent = '';
}

function markFieldInvalid(el){
  if(el) el.classList.add('field-invalid');
}

function clearFieldInvalid(el){
  if(el) el.classList.remove('field-invalid');
}

function clearAllFieldInvalidStyles(){
  document.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
}

/* Returns { valid: boolean, focusEl, message } */
function validateMandatoryFieldsForSubmit(){
  clearAllFieldInvalidStyles();

  const hospitalEl = document.getElementById('hospital');
  const patientEl = document.getElementById('patient');

  // --- Hospital (required for both claim types) ---
  if(!hospitalEl || !hospitalEl.value){
    markFieldInvalid(hospitalEl);
    return { valid: false, focusEl: hospitalEl, message: 'Hospital is required. Please select a hospital before submitting.' };
  }

  // Billing Sheet claims don't collect Patient / Date of Service / Item
  // Number on this form, so only Patient Claim needs the remaining checks.
  if(currentClaimType !== 'patient'){
    return { valid: true };
  }

  // --- Patient ---
  if(!patientEl || !patientEl.value){
    markFieldInvalid(patientEl);
    return { valid: false, focusEl: patientEl, message: 'Patient is required. Please select a patient before submitting.' };
  }

  // --- Claim Items: Date of Service + Item Number, every row ---
  const rows = document.querySelectorAll('#claim-items-body tr');
  for (const row of rows) {
    const dateInput = row.querySelector('.date-input');
    const itemInput = row.querySelector('.item-lookup-input');
    const itemHidden = row.querySelector('.item-select');

    const missingDate = !dateInput || !dateInput.value.trim();
    const missingItem = !itemHidden || !itemHidden.value.trim();

    if(missingDate){
      markFieldInvalid(dateInput);
    }
    if(missingItem){
      markFieldInvalid(itemInput);
    }

    if(missingDate || missingItem){
      const focusEl = missingDate ? dateInput : itemInput;
      const rowNum = row.cells && row.cells[0] ? row.cells[0].textContent : '';
      let message;
      if(missingDate && missingItem){
        message = `Date of Service and Item Number are required for claim item row ${rowNum}.`;
      } else if(missingDate){
        message = `Date of Service is required for claim item row ${rowNum}.`;
      } else {
        message = `Item Number is required for claim item row ${rowNum}.`;
      }
      return { valid: false, focusEl, message };
    }
  }

  return { valid: true };
}
function selectAdmissionType(type){
  currentAdmissionType = type;
  document.querySelectorAll('.admission-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
}
async function buildClaimPayload(status){
  const hospitalEl = document.getElementById('hospital');
  const patientEl = document.getElementById('patient');
  const payerEl = document.getElementById('payer');
  const referringDoctorEl = document.getElementById('referringDoctor');
  const referringDoctorProviderEl = document.getElementById('referringDoctorProvider');
  const asstSurgeryClaimEl = document.getElementById('asstSurgeryClaim');
  const primarySurgeonNameEl = document.getElementById('primarySurgeonName');
  const primarySurgeonItemNumbersEl = document.getElementById('primarySurgeonItemNumbers');
  const enableGapEl = document.getElementById('enableGap');
  const gapAmountEl = document.getElementById('gapAmount');

  const data = {
    Doctor: doctorRecordId,
    Hospital: hospitalEl ? hospitalEl.value : '',
    Claim_Submission_Type: currentClaimType === 'patient' ? 'Patient Claim' : 'Billing Sheet',
    Status: status,
    Claim_Status: "Draft"
  };

  if(currentClaimType === 'patient'){
    data.Patient = patientEl ? patientEl.value : '';
    data.Payer = payerEl ? payerEl.value : '';
    data.Referring_Doctor = await resolveReferringDoctorId();
    data.Provider_Number = referringDoctorProviderEl ? referringDoctorProviderEl.value : '';
    data.Assistant_Surgeon = asstSurgeryClaimEl ? asstSurgeryClaimEl.value : 'No';
    data.Claim_Type_Admission_Type = currentAdmissionType;
if(asstSurgeryClaimEl && asstSurgeryClaimEl.value === 'Yes'){
  // primarySurgeonNameEl.value is the record ID from All_Assistant_Surgeons
  data.Assistant_Surgeon1 = primarySurgeonNameEl ? primarySurgeonNameEl.value : '';
  data.Primary_Surgeon_Item_Number = primarySurgeonItemNumbersEl ? primarySurgeonItemNumbersEl.value : '';
}
    data.Enable_Gap = enableGapEl ? enableGapEl.checked : false;
    data.GAP_Amount = (enableGapEl && enableGapEl.checked && gapAmountEl) ? gapAmountEl.value : '';
    data.Items = collectClaimItems();
  } else {
    const commentsEl = document.querySelector('#billing-subform textarea');
    data.Comments = commentsEl ? commentsEl.value : '';
  }

  return data;
}
function updateClaimStatusBadge(status){
  const badge = document.getElementById('claimStatusBadge');
  if(!badge) return;
  badge.textContent = status;
}
async function uploadClaimFiles(recordId, status){
  const fileInputId = currentClaimType === 'patient' ? 'patientFileInput' : 'billingFileInput';
  const fileInput = document.getElementById(fileInputId);

  if(!fileInput || !fileInput.files || fileInput.files.length === 0){
    return;
  }

  // Draft records only satisfy the Draft-filtered report; Submitted records
  // only satisfy the Submitted-filtered report. Route to whichever one
  // actually contains the record we just created.
  const reportName = status === 'Draft' ? 'Submit_Claims' : 'Add_Doctors_Claim_Report';

  for(const file of fileInput.files){
    try {
      const uploadConfig = {
        report_name: reportName,
        id: recordId,
        field_name: "File_upload",
        file: file
      };
      const uploadResponse = await ZOHO.CREATOR.FILE.uploadFile(uploadConfig);
      console.log("File upload response:", uploadResponse);

      if(!uploadResponse || uploadResponse.code !== 3000){
        console.error("File upload failed:", uploadResponse);
      }
    } catch (err) {
      console.error("File upload error for", file.name, err);
    }
  }
}

function showSuccessModal(title, subtitle){
  const modal = document.getElementById('successModal');
  const titleEl = document.getElementById('modalTitle');
  const subtitleEl = document.getElementById('modalSubtitle');
  if(!modal) return;
  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  modal.classList.add('active');
}

function hideSuccessModal(){
  const modal = document.getElementById('successModal');
  if(modal) modal.classList.remove('active');
}

function goToSubmitClaimsReport(){
  const reportHash = "#Report:Submit_Claims";

  try {
    const topUrl = new URL(window.top.location.href);
    const targetUrl = topUrl.origin + topUrl.pathname + reportHash;
    window.open(targetUrl, "_top");
    return;
  } catch (err) {
    console.warn("Could not read window.top.location, falling back:", err);
  }

  window.open("https://portal.medielves.com.au/#Report:Submit_Claims", "_top");
}

async function saveClaim(status){
  const btn = status === 'Draft' ? document.getElementById('draft-btn') : document.getElementById('submit-btn');

  // Mandatory field check runs only for Submit, not Save as Draft.
  if(status !== 'Draft'){
    const validation = validateMandatoryFieldsForSubmit();
    if(!validation.valid){
      showClaimError(validation.message);
      if(validation.focusEl && typeof validation.focusEl.focus === 'function'){
        validation.focusEl.focus();
        validation.focusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;   // cancel submit
    }
    clearClaimError();
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = status === 'Draft' ? 'Saving...' : 'Submitting...';

  try {
    const payload = await buildClaimPayload(status);

    const config = {
      form_name: "Add_Doctors_Claim",
      payload: {
        data: payload
      }
    };

    const response = await ZOHO.CREATOR.DATA.addRecords(config);
    console.log("Save claim response:", response);

    if(response && response.code === 3000){
  updateClaimStatusBadge(status === 'Draft' ? 'Draft' : 'Submitted');
  const newRecordId = response.data && response.data.ID;

  if(newRecordId){
    await uploadClaimFiles(newRecordId, status);   // <-- pass status
  }

  showSuccessModal(
    status === 'Draft' ? "Claim Saved Successfully" : "Claim Submitted Successfully",
    status === 'Draft' ? "Your claim has been saved as a draft." : "Your claim has been submitted for approval."
  );
}else {
      console.error("Unexpected response saving claim:", response);
      alert("Something went wrong while saving the claim. Please try again.");
    }

  } catch (err) {
    console.error("Save claim error:", err);
    alert("Failed to save the claim. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

document.addEventListener("DOMContentLoaded", async function () {
  initClaimForm();   // fire and forget — don't block on it
  // fetchHospitals();
  fetchHealthFunds();
  fetchPatients();
  fetchReferringDoctors();
  fetchItems();
   fetchAssistantSurgeons();   // <-- ADD THIS
  wireDropzone('patientDropzone', 'patientBrowseLink', 'patientFileInput', 'patientFileList');
  wireDropzone('billingDropzone', 'billingBrowseLink', 'billingFileInput', 'billingFileList');
  wireSinglePayerSelection();
  wirePayerNumberValidation();
  wirePayerOptionAvailability();

  const hospitalEl = document.getElementById('hospital');
  if(hospitalEl){
    hospitalEl.addEventListener('change', () => {
      clearFieldInvalid(hospitalEl);
      clearClaimError();
    });
  }

  document.getElementById('draft-btn').addEventListener('click', () => saveClaim('Draft'));
  document.getElementById('submit-btn').addEventListener('click', () => saveClaim('Submitted'));
  document.getElementById('modalContinueBtn').addEventListener('click', () => {
    hideSuccessModal();
    goToSubmitClaimsReport();
  });
});