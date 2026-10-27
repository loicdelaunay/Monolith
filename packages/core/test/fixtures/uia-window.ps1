param([string]$Title)
# Fenêtre de test hors écran, affichée sans activation : ne vole ni le focus ni le curseur.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
public class QuietForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
"@
function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
$f = New-Object QuietForm
$f.Text = $Title
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-3000, -3000)
$f.Size = New-Object System.Drawing.Size(320, 200)
$f.ShowInTaskbar = $false
$b = New-Object System.Windows.Forms.Button
$b.Text = 'Valider'; $b.Name = 'valider'; $b.Location = New-Object System.Drawing.Point(10, 10)
$b.Add_Click({ Say 'clicked' })
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'champ'; $t.Location = New-Object System.Drawing.Point(10, 50); $t.Width = 200
$t.Add_TextChanged({ Say ('text:' + $t.Text) })
$c = New-Object System.Windows.Forms.CheckBox
$c.Text = 'Option'; $c.Name = 'option'; $c.Location = New-Object System.Drawing.Point(10, 90)
$c.Add_CheckedChanged({ Say ('checked:' + $c.Checked) })
$f.Controls.AddRange(@($b, $t, $c))
$f.Add_Shown({ Say 'ready' })
[System.Windows.Forms.Application]::Run($f)
