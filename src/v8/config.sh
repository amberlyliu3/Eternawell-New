# Clinic details for v8. tools/build.sh reads this file after its defaults, so these values win.
# The phone number and address are wrapped in data-set spans so the doctor can change them
# from the admin area (Clinic details) without a rebuild.
export PHONE_DISPLAY='<span data-set="phone">(206) 507-2504</span>'
export PHONE_TEL="+12065072504"
export ADDRESS_1='<span data-set="address1">2700 Richards Rd, Suite 204A</span>'
export ADDRESS_2='<span data-set="address2">Bellevue, WA 98005</span>'
export MAP_URL="https://www.google.com/maps/search/?api=1&amp;query=2700+Richards+Rd+Suite+204A+Bellevue+WA+98005"
export PORTAL_URL="https://www.optimantra.com/optimus/om/patient/login"
# Mark text and photos so the admin editor can change them (tools/editable.py)
export EDITABLE=1
