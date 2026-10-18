import urllib.request,json,datetime,pathlib
results=[]
for appid,name in [(730,'Counter-Strike 2'),(570,'Dota 2'),(1172470,'Apex Legends')]:
 source=f'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}'
 x=json.load(urllib.request.urlopen(source,timeout=15))['response'];assert x['result']==1 and isinstance(x['player_count'],int) and x['player_count']>=0
 results.append(dict(appid=appid,name=name,players=x['player_count'],source=source,ok=True))
text='# HELP steam_players_online Steam-connected players reported by Valve\n# TYPE steam_players_online gauge\n'+'\n'.join(f'steam_players_online{{game="{r["name"]}",appid="{r["appid"]}"}} {r["players"]}'for r in results)+'\n'
out=dict(capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),results=results,text=text,scope='Recorded public Steam API snapshot. Steam-connected players only. Not affiliated with Valve.')
p=pathlib.Path(__file__).resolve().parents[1]/'src/data/steam.json';p.write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
