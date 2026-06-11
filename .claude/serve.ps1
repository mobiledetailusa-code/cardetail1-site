Add-Type -AssemblyName System.Net

$tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 5500)
$tcp.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
$tcp.Start()
Write-Host "Ready on http://localhost:5500"

$root = 'C:\Users\magno\Desktop\dz project'
$homePage = 'index.html'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.webp' = 'image/webp'
    '.txt'  = 'text/plain; charset=utf-8'
}

# URL-limpa → arquivo (espelha os redirects do netlify.toml)
$clean = @{
    '/'           = $homePage
    '/customer'   = 'customer.html'
    '/technician' = 'technician.html'
    '/admin'      = 'admin.html'
    '/terms-conditions' = 'terms-conditions.html'
}

while ($true) {
    $client = $tcp.AcceptTcpClient()
    $client.SendTimeout    = 30000
    $client.ReceiveTimeout = 5000
    $client.SendBufferSize = 131072
    $ns = $client.GetStream()

    # Lê a request line para extrair o path
    $reqBuf = [byte[]]::new(8192)
    $read = 0
    try { $read = $ns.Read($reqBuf, 0, $reqBuf.Length) } catch {}
    $reqText = [System.Text.Encoding]::ASCII.GetString($reqBuf, 0, [Math]::Max($read,0))
    $path = '/'
    if ($reqText -match '^[A-Z]+\s+(\S+)\s+HTTP') { $path = $matches[1] }
    $path = ($path -split '\?')[0]              # tira querystring
    try { $path = [System.Uri]::UnescapeDataString($path) } catch {}

    # Resolve path → arquivo
    $rel = $null
    if ($clean.ContainsKey($path)) { $rel = $clean[$path] }
    elseif ($path -eq '' ) { $rel = $homePage }
    else { $rel = $path.TrimStart('/') }

    $full = Join-Path $root $rel
    # Segurança: impede path traversal para fora da raiz
    $resolved = $null
    try { $resolved = [System.IO.Path]::GetFullPath($full) } catch {}

    if ($resolved -and $resolved.StartsWith($root) -and [System.IO.File]::Exists($resolved)) {
        $ext  = [System.IO.Path]::GetExtension($resolved).ToLower()
        $ct   = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $body = [System.IO.File]::ReadAllBytes($resolved)
        $hdr  = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
        $status = "200 $rel"
    } else {
        $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
        $hdr  = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        $status = "404 $path"
    }

    $hdrB = [System.Text.Encoding]::ASCII.GetBytes($hdr)
    try {
        $ns.Write($hdrB, 0, $hdrB.Length)
        $ns.Write($body, 0, $body.Length)
        $ns.Flush()
        Write-Host "Served $status ($($body.Length) bytes)"
    } catch {
        Write-Host "ERR: $($_.Exception.Message)"
    }
    try { $ns.Close() } catch {}
    try { $client.Close() } catch {}
}
