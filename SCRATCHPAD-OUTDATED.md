## Monday.com Integration

### To Push Data into Monday.com

Monday access token:

```
eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjUxNDk4ODk1MywiYWFpIjoxMSwidWlkIjo3MjYzNTk4OCwiaWFkIjoiMjAyNS0wNS0xOVQyMjowMjowMS4zMDVaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjgyMDc1NDksInJnbiI6InVzZTEifQ.qkN32wKoSdIe5j0HxaxgShcVM56AR1kSC5DtoeahtNc
```

```graphql
mutation {
  create_item (board_id: 1234567890, group_id: "group_one", item_name: "new item", column_values: "{\"date\":\"2023-05-25\"}") {
    id
  }
}
```

Note how the column_values field is stringified JSON. I don't think we need a group_id for Contracts. Not sure what item_name is.

### To Get the List of Columns

```javascript
let query = "query {boards (ids: 1234567890) { columns { id title }}}";

fetch ("https://api.monday.com/v2", {
  method: 'post',
  headers: {
    'Content-Type': 'application/json',
    'Authorization' : 'YourSuperSecretApiKey'
   },
   body: JSON.stringify({
     'query': query
   })
  })
   .then(res => res.json())
   .then(res => console.log(JSON.stringify(res, null, 2)));
```
