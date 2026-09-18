/* Seed data: three salons proving one codebase serves many brands.
   Times are written as 'HH:MM-HH:MM' strings, 'OFF' for a closed day,
   or comma-separated windows. engine.normalizeSeed() expands them. */
var DATA = {
  salons: [
    {
      id: 'goldenhue',
      name: 'Goldenhue Studio',
      tagline: 'Hair, colour & keratin since 2009',
      address: '12 Lavelle Road, Bengaluru 560001',
      phone: '+91 80 4123 8890',
      slotStepMin: 15,
      leadTimeMin: 60,
      horizonDays: 45,
      cancellationHours: 4,
      est: 'Est. 2009',
      cover: 'img/cover-goldenhue.webp',
      gallery: ['img/craft-1.jpg', 'img/craft-2.jpg', 'img/craft-5.webp'],
      headline: 'Twelve years of colour, cuts and slow mornings.',
      sub: 'Walk in for a trim, settle in for a keratin. Either way, we will not rush you.',
      reviews: [
        { name: 'Divya P', service: 'Keratin Treatment', text: 'Ramesh talked me out of the treatment I asked for and into the one I actually needed. Six months on, still straight.' },
        { name: 'Kavya S', service: 'Hair Colour', text: 'Anjali matched my colour to a photo better than the salon that took the photo.' }
      ],
      brand: { light: '#FFC93C', ink: '#1A1408', deep: '#7A5A00' },
      hours: ['09:00-20:00','09:00-20:00','09:00-20:00','09:00-20:00','09:00-20:00','09:00-20:00','10:00-18:00']
    },
    {
      id: 'blushbloom',
      name: 'Blush & Bloom',
      tagline: 'Skin, nails & slow beauty',
      address: 'Linking Road, Bandra West, Mumbai 400050',
      phone: '+91 22 6641 2200',
      slotStepMin: 15,
      leadTimeMin: 120,
      horizonDays: 30,
      cancellationHours: 12,
      est: 'Est. 2016',
      cover: 'img/craft-4.jpg',
      gallery: ['img/craft-4.jpg', 'img/craft-1.jpg', 'img/craft-2.jpg'],
      headline: 'Skin first. Nails second. Everything else can wait.',
      sub: 'A small studio on Linking Road built around facials that actually change something.',
      reviews: [
        { name: 'Ritu B', service: 'Classic Facial', text: 'Three sessions in and my acne scars have genuinely faded. Meera explains every step before she does it.' },
        { name: 'Sara K', service: 'Gel Manicure', text: 'Two weeks of dishwashing later and not one chip. Tanya is worth the wait.' }
      ],
      brand: { light: '#FF4D8D', ink: '#2A0714', deep: '#B01B57' },
      hours: ['10:00-20:00','10:00-20:00','10:00-20:00','10:00-20:00','10:00-20:00','10:00-20:00','OFF']
    },
    {
      id: 'cuttingroom',
      name: 'The Cutting Room',
      tagline: 'Sharp cuts, no fuss',
      address: '5th Block, Koramangala, Bengaluru 560095',
      phone: '+91 80 4967 1120',
      slotStepMin: 30,
      leadTimeMin: 30,
      horizonDays: 21,
      cancellationHours: 2,
      est: 'Est. 2021',
      cover: 'img/cover-cuttingroom.webp',
      gallery: ['img/craft-2.jpg', 'img/craft-5.webp', 'img/craft-1.jpg'],
      headline: 'Sharp cuts. No fuss. No small talk.',
      sub: 'Walk-ins welcome, but the diary fills by evening. Book a chair and skip the wait.',
      reviews: [
        { name: 'Imran H', service: 'Cut + Beard Combo', text: 'First barber in Koramangala who listened when I said short on the sides, long on top.' },
        { name: 'Deepak J', service: "Men's Cut", text: 'In and out in twenty-five minutes, exactly the fade I asked for. No upselling.' }
      ],
      brand: { light: '#C8F53C', ink: '#101A03', deep: '#4C6B00' },
      hours: ['10:00-21:00','10:00-21:00','10:00-21:00','10:00-21:00','10:00-21:00','10:00-21:00','10:00-21:00']
    }
  ],

  services: [
    /* Goldenhue */
    { id: 'gh-haircut', salonId: 'goldenhue', name: 'Haircut & Styling', category: 'Hair', photo: 'img/craft-1.jpg',
      desc: 'Consultation, wash, precision cut and blow-dry finish.', durationMin: 45, bufferMin: 10, price: 80000 },
    { id: 'gh-colour', salonId: 'goldenhue', name: 'Hair Colour', category: 'Colour', photo: 'img/craft-1.jpg',
      desc: 'Global or root colour with ammonia-free formulas.', durationMin: 120, bufferMin: 15, price: 250000 },
    { id: 'gh-keratin', salonId: 'goldenhue', name: 'Keratin Treatment', category: 'Treatments', photo: 'img/craft-1.jpg',
      desc: 'Frizz control and smoothing that lasts up to 4 months.', durationMin: 180, bufferMin: 20, price: 400000 },
    { id: 'gh-beard', salonId: 'goldenhue', name: 'Beard Sculpt', category: 'Grooming', photo: 'img/craft-5.webp',
      desc: 'Shape, line-up and hot towel finish.', durationMin: 30, bufferMin: 5, price: 45000 },
    { id: 'gh-spa', salonId: 'goldenhue', name: 'Scalp & Hair Spa', category: 'Treatments', photo: 'img/craft-2.jpg',
      desc: 'Deep-conditioning ritual with a 10-minute head massage.', durationMin: 60, bufferMin: 10, price: 150000 },

    /* Blush & Bloom */
    { id: 'bb-mani', salonId: 'blushbloom', name: 'Gel Manicure', category: 'Nails', photo: 'img/craft-4.jpg',
      desc: 'Cuticle work, shape and long-wear gel colour.', durationMin: 60, bufferMin: 10, price: 180000 },
    { id: 'bb-facial', salonId: 'blushbloom', name: 'Classic Facial', category: 'Skin', photo: 'img/craft-4.jpg',
      desc: 'Clean-up, exfoliation and a hydrating mask.', durationMin: 75, bufferMin: 15, price: 220000 },
    { id: 'bb-wax', salonId: 'blushbloom', name: 'Full Arms & Underarms', category: 'Skin', photo: 'img/craft-2.jpg',
      desc: 'Roll-on wax with a soothing post-care gel.', durationMin: 30, bufferMin: 5, price: 70000 },
    { id: 'bb-blowdry', salonId: 'blushbloom', name: 'Blow-dry & Set', category: 'Hair', photo: 'img/craft-1.jpg',
      desc: 'Wash, blow-dry and finishing for any occasion.', durationMin: 45, bufferMin: 10, price: 120000 },

    /* The Cutting Room */
    { id: 'cr-cut', salonId: 'cuttingroom', name: "Men's Cut", category: 'Hair', photo: 'img/craft-1.jpg',
      desc: 'Clipper or scissor cut with a clean finish.', durationMin: 30, bufferMin: 5, price: 50000 },
    { id: 'cr-beard', salonId: 'cuttingroom', name: 'Beard Sculpt', category: 'Grooming', photo: 'img/craft-5.webp',
      desc: 'Trim, shape and line-up with hot towel.', durationMin: 30, bufferMin: 5, price: 35000 },
    { id: 'cr-combo', salonId: 'cuttingroom', name: 'Cut + Beard Combo', category: 'Hair', photo: 'img/craft-1.jpg',
      desc: 'Both services back to back, one price.', durationMin: 60, bufferMin: 10, price: 75000 },
    { id: 'cr-massage', salonId: 'cuttingroom', name: 'Head Massage', category: 'Grooming', photo: 'img/craft-2.jpg',
      desc: 'Twenty minutes of champi with warm oil.', durationMin: 20, bufferMin: 5, price: 30000 }
  ],

  staff: [
    /* Goldenhue */
    { id: 'ramesh', salonId: 'goldenhue', name: 'Ramesh Iyer', title: 'Senior Stylist · 12 yrs',
      bio: 'Colour corrections and keratin specialist. Trained in Chennai and Singapore.',
      services: ['gh-haircut','gh-colour','gh-keratin','gh-beard'],
      hours: ['09:00-18:00','09:00-18:00','OFF','10:00-19:00','09:00-18:00','09:00-17:00','OFF'],
      breaks: [['13:00','14:00','Lunch']],
      exceptions: [{ dayOffset: 2, kind: 'day_off', reason: 'Family function' }] },
    { id: 'anjali', salonId: 'goldenhue', name: 'Anjali Rao', title: 'Colour Lead · 8 yrs',
      bio: 'Balayage, global colour and bridal styling.',
      services: ['gh-haircut','gh-colour','gh-spa'],
      hours: ['10:00-19:00','10:00-19:00','10:00-19:00','OFF','10:00-19:00','10:00-19:00','12:00-17:00'],
      breaks: [['14:00','14:45','Lunch']],
      exceptions: [{ dayOffset: 5, kind: 'custom_hours', start: '10:00', end: '14:00', reason: 'Half day' }] },
    { id: 'priya', salonId: 'goldenhue', name: 'Priya Menon', title: 'Stylist · 5 yrs',
      bio: 'Cuts, blow-dries and hair spa. Great with curly hair.',
      services: ['gh-haircut','gh-spa','gh-beard'],
      hours: ['OFF','11:00-20:00','11:00-20:00','11:00-20:00','11:00-20:00','11:00-20:00','OFF'],
      breaks: [['15:00','15:30','Break']],
      exceptions: [] },

    /* Blush & Bloom */
    { id: 'meera', salonId: 'blushbloom', name: 'Meera Shah', title: 'Skin Therapist · 9 yrs',
      bio: 'Facials, peels and acne care.',
      services: ['bb-facial','bb-wax'],
      hours: ['10:00-19:00','10:00-19:00','10:00-19:00','10:00-19:00','10:00-19:00','10:00-19:00','OFF'],
      breaks: [['13:30','14:15','Lunch']], exceptions: [] },
    { id: 'tanya', salonId: 'blushbloom', name: 'Tanya Fernandes', title: 'Nail Artist · 6 yrs',
      bio: 'Gel extensions, nail art and spa manicures.',
      services: ['bb-mani','bb-wax','bb-blowdry'],
      hours: ['11:00-20:00','11:00-20:00','OFF','11:00-20:00','11:00-20:00','11:00-20:00','OFF'],
      breaks: [['16:00','16:30','Break']], exceptions: [] },
    { id: 'sneha', salonId: 'blushbloom', name: 'Sneha Kulkarni', title: 'Hair Stylist · 7 yrs',
      bio: 'Blow-dries, updos and occasion styling.',
      services: ['bb-blowdry','bb-mani'],
      hours: ['OFF','12:00-20:00','12:00-20:00','12:00-20:00','12:00-20:00','12:00-20:00','OFF'],
      breaks: [], exceptions: [{ dayOffset: 3, kind: 'day_off', reason: 'Leave' }] },

    /* The Cutting Room */
    { id: 'arjun', salonId: 'cuttingroom', name: 'Arjun Nair', title: 'Master Barber · 10 yrs',
      bio: 'Skin fades, classic cuts and beard work.',
      services: ['cr-cut','cr-beard','cr-combo'],
      hours: ['10:00-21:00','10:00-21:00','10:00-21:00','OFF','10:00-21:00','10:00-21:00','10:00-21:00'],
      breaks: [['14:00','15:00','Lunch']], exceptions: [] },
    { id: 'vikram', salonId: 'cuttingroom', name: 'Vikram Desai', title: 'Barber · 4 yrs',
      bio: 'Quick, precise cuts and hot towel shaves.',
      services: ['cr-cut','cr-beard','cr-massage'],
      hours: ['11:00-21:00','11:00-21:00','11:00-21:00','11:00-21:00','OFF','11:00-21:00','11:00-21:00'],
      breaks: [['17:00','17:30','Break']], exceptions: [] },
    { id: 'sameer', salonId: 'cuttingroom', name: 'Sameer Khan', title: 'Barber · 6 yrs',
      bio: 'Fades, beard sculpting and head massage.',
      services: ['cr-cut','cr-combo','cr-massage'],
      hours: ['10:00-20:00','OFF','10:00-20:00','10:00-20:00','10:00-20:00','10:00-20:00','12:00-18:00'],
      breaks: [['13:00','13:45','Lunch']], exceptions: [] }
  ],

  salonsClosed: [
    { salonId: 'goldenhue', dayOffset: 6, reason: 'Staff training day' }
  ],

  /* Pre-existing bookings so the first screen already looks lived-in.
     dayOffset is relative to today, so the demo never looks stale. */
  appointments: [
    { salonId: 'goldenhue', staffId: 'ramesh',  serviceId: 'gh-colour',  dayOffset: 0, start: '11:00', customerName: 'Kavya S' },
    { salonId: 'goldenhue', staffId: 'ramesh',  serviceId: 'gh-haircut', dayOffset: 0, start: '16:30', customerName: 'Rohit M' },
    { salonId: 'goldenhue', staffId: 'anjali',  serviceId: 'gh-keratin', dayOffset: 0, start: '10:00', customerName: 'Divya P' },
    { salonId: 'goldenhue', staffId: 'anjali',  serviceId: 'gh-haircut', dayOffset: 1, start: '12:00', customerName: 'Nikhil R' },
    { salonId: 'goldenhue', staffId: 'priya',   serviceId: 'gh-spa',     dayOffset: 1, start: '11:30', customerName: 'Asha V' },
    { salonId: 'blushbloom', staffId: 'meera',  serviceId: 'bb-facial',  dayOffset: 0, start: '11:00', customerName: 'Ritu B' },
    { salonId: 'blushbloom', staffId: 'tanya',  serviceId: 'bb-mani',    dayOffset: 0, start: '15:00', customerName: 'Sara K' },
    { salonId: 'cuttingroom', staffId: 'arjun', serviceId: 'cr-combo',   dayOffset: 0, start: '18:00', customerName: 'Imran H' },
    { salonId: 'cuttingroom', staffId: 'vikram', serviceId: 'cr-cut',    dayOffset: 0, start: '12:30', customerName: 'Deepak J' }
  ]
};

if (typeof module !== 'undefined' && module.exports) { module.exports = DATA; }
