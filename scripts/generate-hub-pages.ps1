$root = "C:\Users\magno\Desktop\dz project"
$template = Get-Content -Path (Join-Path $root "template-city.html") -Raw -Encoding UTF8

$hubs = @(
  @{
    file = "bergen-county-hub.html"
    name = "Bergen County"
    badge = "Serving Bergen County and North Jersey"
    sub = "Premium mobile detailing across Bergen County, from Palisades Park to Fort Lee. We bring the water, power, and expertise to your driveway."
    footAreas = "Palisades Park, Hackensack, Englewood, Teaneck, Paramus, Fort Lee"
  },
  @{
    file = "hudson-county-hub.html"
    name = "Hudson County"
    badge = "Serving Hudson County and the Gold Coast"
    sub = "Professional mobile detailing in Hudson County: Jersey City, Hoboken, and waterfront neighborhoods. Showroom finish at your door."
    footAreas = "Jersey City, Hoboken, Bayonne, Union City, Weehawken"
  },
  @{
    file = "essex-county-hub.html"
    name = "Essex County"
    badge = "Serving Essex County and Greater Newark"
    sub = "Mobile detailing for Essex County: Newark, Elizabeth, Bloomfield, and West Orange. Fully equipped, fully mobile."
    footAreas = "Newark, Elizabeth, Bloomfield, West Orange, Montclair"
  },
  @{
    file = "passaic-county-hub.html"
    name = "Passaic County"
    badge = "Serving Passaic County and North Jersey"
    sub = "Expert mobile detailing in Passaic County: Paterson, Wayne, Clifton, and Franklin Lakes. We come to you."
    footAreas = "Paterson, Wayne, Clifton, Franklin Lakes, Pompton Lakes"
  },
  @{
    file = "ny-metro-hub.html"
    name = "NY Metro"
    badge = "Serving NYC, Westchester and the Tri-State"
    sub = "Premium mobile detailing across the NY Metro: Manhattan, Bronx, Queens, and Westchester County. Book online, we come to you."
    footAreas = "Manhattan, Bronx, Queens, Westchester, Brooklyn"
  },
  @{
    file = "connecticut-hub.html"
    name = "Connecticut"
    badge = "Serving Connecticut & Fairfield County"
    sub = "Premium mobile detailing across Connecticut — Waterbury, Hartford, New Haven, Danbury, and Stamford. We bring the water, power, and expertise to your driveway."
    footAreas = "Waterbury, Hartford, New Haven, Danbury, Stamford"
  },
  @{
    file = "pennsylvania-hub.html"
    name = "Pennsylvania"
    badge = "Serving Pennsylvania & Delaware Valley"
    sub = "Premium mobile detailing across Pennsylvania — Philadelphia, Allentown, King of Prussia, and Scranton. We bring the water, power, and expertise to your driveway."
    footAreas = "Philadelphia, Allentown, King of Prussia, Scranton"
  }
)

$navOld = '<a class="nav-brand-img" href="#" onclick="window.scrollTo({top:0,behavior:''smooth''});return false;" aria-label="Cardetail1 Home">'
$navFix = '<a class="nav-brand-img" href="index.html" aria-label="Cardetail1 Home">'

$footContactOld = @'
      <div class="foot-col">
        <h4>Contact</h4>
'@

$footQuickLinks = @'
      <div class="foot-col">
        <h4>Quick Links</h4>
        <a href="index.html">Home</a>
        <a href="rv-detailing.html">RV Detailing</a>
        <a href="fleet-services.html">Fleet Services</a>
      </div>
      <div class="foot-col">
        <h4>Contact</h4>
'@

$bookOld = 'class="btn-primary" style="font-size:15px;padding:18px 36px;margin-bottom:8px" onclick="openBooking(null)">Book Mobile Detailing'
$bookFix = 'class="btn-primary booking-popup-trigger" style="font-size:15px;padding:18px 36px;margin-bottom:8px" onclick="openBooking(null)">Book Mobile Detailing'

$zipInit = @'
(function initHubZipFromQuery(){
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('zip') || sessionStorage.getItem('cd1_zip') || '';
  const zip5 = String(raw).replace(/\D/g,'').slice(0, 5);
  if(zip5.length === 5){
    const inp = document.getElementById('hero-zip');
    if(inp){
      inp.value = zip5;
      if(typeof onHeroZipInput === 'function') onHeroZipInput(zip5);
    }
  }
})();

'@

foreach ($hub in $hubs) {
  $html = $template
  $html = $html.Replace("{CITY_NAME}", $hub.name)
  $html = $html.Replace($navOld, $navFix)
  $html = $html.Replace($footContactOld, $footQuickLinks)
  $html = $html.Replace($bookOld, $bookFix)
  $html = $html.Replace('<link rel="canonical" href="https://cardetail1.com/">', ('<link rel="canonical" href="https://cardetail1.com/' + $hub.file + '">'))
  $html = $html.Replace('<meta property="og:url" content="https://cardetail1.com/">', ('<meta property="og:url" content="https://cardetail1.com/' + $hub.file + '">'))
  $html = $html.Replace(('<title>Mobile Detailing in ' + $hub.name + ' | Cardetail1</title>'), ('<title>Premium Mobile Detailing in ' + $hub.name + ' | Cardetail1</title>'))
  $html = $html.Replace(('<div class="hero-badge">Serving ' + $hub.name + ' &amp; Surrounding Areas | Fully Mobile Service</div>'), ('<div class="hero-badge">' + $hub.badge + ' | Fully Mobile Service</div>'))
  $html = $html.Replace(('Serving ' + $hub.name + ' &amp; Surrounding Areas'), $hub.badge)
  $oldSub = 'Professional mobile detailing in ' + $hub.name + ' — we bring the water, the power, and the expertise directly to your driveway. No waiting rooms, no hassle—just a showroom finish at your doorstep.'
  $html = $html.Replace(('<p class="hero-sub">' + $oldSub + '</p>'), ('<p class="hero-sub">' + $hub.sub + '</p>'))
  $html = $html.Replace('<div class="foot-areas">Serving Bergen County · Hudson County · Manhattan · Long Island · Fairfield CT · and surrounding areas</div>', ('<div class="foot-areas">Serving ' + $hub.footAreas + ' and surrounding areas. <a href="index.html" style="color:var(--mu);text-decoration:none">All service areas</a></div>'))
  $html = $html.Replace("renderReviews();`r`nrenderLocationCarousel('default');", ($zipInit + "renderReviews();`r`nrenderLocationCarousel('default');"))
  $html = $html.Replace("renderReviews();`nrenderLocationCarousel('default');", ($zipInit + "renderReviews();`nrenderLocationCarousel('default');"))

  $outPath = Join-Path $root $hub.file
  [System.IO.File]::WriteAllText($outPath, $html, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Created $($hub.file)"
}
